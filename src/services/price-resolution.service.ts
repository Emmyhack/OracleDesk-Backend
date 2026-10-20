/**
 * Price-mode markets (#90).
 *
 * A CRYPTO proposal can commit to a Reflector (SEP-40) feed instead of a
 * signer set: the market stores a `kind: 'price'` resolution spec, the backend
 * reveals it with `register_price_spec` after creation, and after close anyone
 * can call `resolve_price`, which reads the feed at `close_time` and finalises
 * the market. This module owns the deterministic parts: threshold conversion,
 * question rendering, spec building, feed validation, reveal and the
 * resolution loop with its retry/escalation policy.
 */
import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  scValToNative,
  xdr,
  rpc,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { feedFor, type ReflectorFeed, type ReflectorFeedAsset } from '../config/reflector-feeds';
import { logger } from '../lib/logger';
import { writeAgentLog } from '../lib/agent-log';
import {
  validateResolutionSpec,
  type PriceDirectionName,
  type ResolutionSpecJson,
} from '../lib/resolution-spec';
import { registerPriceSpec, resolvePrice, resolverState, type WriteResult } from './chain.service';
import { ChainError } from './stellar/errors';
import { agentSigner, rpcServer } from './stellar/clients';
import type { PriceConfig } from '../generated/resolver';

export type OracleAsset = ReflectorFeedAsset;

export interface ReflectorReader {
  decimals(contract: string): Promise<number>;
  supports(contract: string, asset: OracleAsset): Promise<boolean>;
  lastPrice(contract: string, asset: OracleAsset): Promise<{ price: bigint; timestamp: bigint } | null>;
}

// ─── Threshold conversion ────────────────────────────────────────────────────

/**
 * Converts a human decimal threshold (e.g. "100000", "0.0001") into the feed's
 * fixed-point representation. String arithmetic only: no parseFloat, no
 * rounding. More fractional digits than the feed supports is an error, because
 * silently rounding would flip outcomes.
 */
export function toFixedPoint(human: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('decimals must be a non-negative integer');
  if (!/^\d+(\.\d+)?$/.test(human)) throw new Error('threshold must be a non-negative decimal string');
  const [whole, frac = ''] = human.split('.');
  if (frac.length > decimals) {
    throw new Error(`threshold has ${frac.length} decimal places but the feed supports ${decimals}`);
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded);
}

// ─── Deterministic question text ─────────────────────────────────────────────

const DIRECTION_TEXT: Record<PriceDirectionName, string> = {
  Above: 'above',
  AtOrAbove: 'at or above',
  Below: 'below',
  AtOrBelow: 'at or below',
};

function formatHuman(threshold: string): string {
  const [whole, frac] = threshold.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

export interface PriceQuestionInput {
  symbol: string;
  direction: PriceDirectionName;
  thresholdHuman: string;
  closeTimeSecs: number;
}

/**
 * Rendered from structured fields only, so the question text and the committed
 * spec can never disagree. `AtOrAbove` reads "at or above", `Above` reads
 * "above", and the close timestamp is ISO-8601 UTC.
 */
export function renderPriceQuestion(input: PriceQuestionInput): string {
  const iso = new Date(input.closeTimeSecs * 1000).toISOString().replace('.000Z', 'Z');
  return `Will the Reflector ${input.symbol.toUpperCase()}/USD price be ${DIRECTION_TEXT[input.direction]} ${formatHuman(
    input.thresholdHuman,
  )} at ${iso}?`;
}

// ─── Structured proposal ─────────────────────────────────────────────────────

export const priceProposalSchema = z.object({
  asset: z.string().min(1),
  threshold: z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string'),
  direction: z.enum(['Above', 'AtOrAbove', 'Below', 'AtOrBelow']),
  close_timestamp: z.number().int().positive(),
});

export type PriceProposal = z.infer<typeof priceProposalSchema>;

/** Builds the committed spec. The threshold is stored as the fixed-point string. */
export function buildPriceSpec(
  proposal: Pick<PriceProposal, 'threshold' | 'direction'>,
  feed: ReflectorFeed,
  decimals: number,
): Extract<ResolutionSpecJson, { kind: 'price' }> {
  const spec: Extract<ResolutionSpecJson, { kind: 'price' }> = {
    kind: 'price',
    reflector: feed.reflector,
    asset: feed.asset,
    threshold: toFixedPoint(proposal.threshold, decimals).toString(),
    direction: proposal.direction,
    maxStaleness: feed.maxStaleness,
  };
  validateResolutionSpec(spec);
  return spec;
}

// ─── Reflector reader (default implementation) ───────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000;
const decimalsCache = new Map<string, { at: number; value: number }>();
const assetsCache = new Map<string, { at: number; value: string[] }>();

function assetScVal(asset: OracleAsset): xdr.ScVal {
  if (asset.kind === 'stellar') {
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), new Address(asset.address).toScVal()]);
  }
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(asset.symbol)]);
}

function symbolOf(asset: OracleAsset): string {
  return asset.kind === 'stellar' ? asset.address : asset.symbol;
}

async function simulate(contract: string, fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal | null> {
  const source = new Account(agentSigner().publicKey as string, '0');
  const op = new Contract(contract).call(fn, ...args);
  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(0)
    .build();
  const sim = (await rpcServer.simulateTransaction(tx)) as rpc.Api.SimulateTransactionResponse;
  if (sim && typeof sim === 'object' && 'error' in sim && sim.error) {
    throw new ChainError(`reflector ${fn} simulation failed`, null, { method: fn, cause: String(sim.error) });
  }
  const retval = (sim as { result?: { retval?: xdr.ScVal } }).result?.retval;
  return retval ?? null;
}

function nativePriceData(scVal: xdr.ScVal | null): { price: bigint; timestamp: bigint } | null {
  if (!scVal) return null;
  let native: unknown;
  try {
    native = scValToNative(scVal);
  } catch {
    return null;
  }
  // Option<PriceData>: ScVal void when None, otherwise the struct.
  if (native === null || native === undefined) return null;
  const asRecord = native as Record<string, unknown> | unknown[];
  let price: unknown;
  let timestamp: unknown;
  if (Array.isArray(asRecord)) {
    [price, timestamp] = asRecord;
  } else if (asRecord && typeof asRecord === 'object') {
    price = (asRecord as Record<string, unknown>).price;
    timestamp = (asRecord as Record<string, unknown>).timestamp;
  }
  if (price === undefined || timestamp === undefined || price === null || timestamp === null) return null;
  return { price: BigInt(price as bigint | string | number), timestamp: BigInt(timestamp as bigint | string | number) };
}

/**
 * Minimal SEP-40 client. Only the calls price mode needs are implemented, by
 * simulating an invoke against the contract's public interface.
 */
export function reflectorReader(): ReflectorReader {
  return {
    async decimals(contract) {
      const cached = decimalsCache.get(contract);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
      const raw = await simulate(contract, 'decimals', []);
      const value = Number(scValToNative(raw as xdr.ScVal));
      decimalsCache.set(contract, { at: Date.now(), value });
      return value;
    },
    async supports(contract, asset) {
      const cached = assetsCache.get(contract);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value.includes(symbolOf(asset));
      const raw = await simulate(contract, 'assets', []);
      let symbols: string[] = [];
      try {
        const native = scValToNative(raw as xdr.ScVal) as unknown;
        symbols = (Array.isArray(native) ? native : []).map((a) => symbolOf(a as OracleAsset));
      } catch {
        symbols = [];
      }
      assetsCache.set(contract, { at: Date.now(), value: symbols });
      return symbols.includes(symbolOf(asset));
    },
    async lastPrice(contract, asset) {
      return nativePriceData(await simulate(contract, 'lastprice', [assetScVal(asset)]));
    },
  };
}

// ─── Pre-creation feed validation ────────────────────────────────────────────

export interface FeedCheck {
  ok: boolean;
  reason?:
    | 'NOT_REGISTERED'
    | 'FEED_UNSUPPORTED'
    | 'FEED_STALE'
    | 'NO_DATA';
}

/**
 * A feed that does not support the asset, or that has no recent data, is
 * rejected before the market is committed: a dead feed today is dead at close.
 */
export async function checkFeed(
  network: string,
  symbol: string,
  reader: ReflectorReader,
  now: Date = new Date(),
  feedOverride?: ReflectorFeed | null,
): Promise<FeedCheck> {
  const feed = feedOverride ?? feedFor(network, symbol);
  if (!feed) return { ok: false, reason: 'NOT_REGISTERED' };
  if (!(await reader.supports(feed.reflector, feed.asset))) return { ok: false, reason: 'FEED_UNSUPPORTED' };
  const last = await reader.lastPrice(feed.reflector, feed.asset);
  if (!last) return { ok: false, reason: 'NO_DATA' };
  const age = BigInt(Math.floor(now.getTime() / 1000)) - last.timestamp;
  if (age < 0n || age > BigInt(feed.maxStaleness)) return { ok: false, reason: 'FEED_STALE' };
  return { ok: true };
}

// ─── Structured proposal planning ────────────────────────────────────────────

export interface PriceResolutionBlock {
  kind: 'price';
  asset: string;
  thresholdHuman: string;
  thresholdRaw: string;
  decimals: number;
  direction: PriceDirectionName;
  reflector: string;
}

export interface PricePlan {
  /** Non-null when a committed price spec should replace signer mode. */
  spec: Extract<ResolutionSpecJson, { kind: 'price' }> | null;
  /** Deterministically rendered question, non-null iff `spec` is. */
  question: string | null;
  resolution: PriceResolutionBlock | null;
}

const NOT_A_CANDIDATE: PricePlan = { spec: null, question: null, resolution: null };

export interface PlanPriceMarketInput {
  category: string;
  /** Raw LLM proposal (parsed against priceProposalSchema). */
  proposal: unknown;
  network: string;
  now?: Date;
  reader?: ReflectorReader;
  feed?: ReflectorFeed | null;
}

/**
 * Turns a CRYPTO proposal into a price spec, or falls back to signer mode. Any
 * failure (parse, unregistered asset, dead feed, excess precision) logs
 * `PRICE_SPEC_FALLBACK` and returns null so the caller keeps the current
 * behaviour.
 */
export async function planPriceMarket(
  input: PlanPriceMarketInput,
  marketId: string | null = null,
): Promise<PricePlan> {
  if (input.category.toUpperCase() !== 'CRYPTO') return NOT_A_CANDIDATE;
  const reader = input.reader ?? reflectorReader();
  const now = input.now ?? new Date();

  const fallback = async (reason: string): Promise<PricePlan> => {
    await writeAgentLog({
      agentType: 'MARKET_MAKER',
      level: 'WARN',
      action: 'PRICE_SPEC_FALLBACK',
      marketId: marketId ?? undefined,
      data: { reason },
    }).catch(() => undefined);
    return NOT_A_CANDIDATE;
  };

  const parsed = priceProposalSchema.safeParse(input.proposal);
  if (!parsed.success) return fallback('PARSE_FAILED');
  const proposal = parsed.data;

  const feed = input.feed ?? feedFor(input.network, proposal.asset);
  if (!feed) return fallback('NOT_REGISTERED');

  const check = await checkFeed(input.network, proposal.asset, reader, now, feed);
  if (!check.ok) return fallback(check.reason ?? 'FEED_UNUSABLE');

  let decimals: number;
  let spec: Extract<ResolutionSpecJson, { kind: 'price' }>;
  try {
    decimals = await reader.decimals(feed.reflector);
    spec = buildPriceSpec(proposal, feed, decimals);
  } catch {
    return fallback('THRESHOLD_PRECISION');
  }

  return {
    spec,
    question: renderPriceQuestion({
      symbol: proposal.asset,
      direction: proposal.direction,
      thresholdHuman: proposal.threshold,
      closeTimeSecs: proposal.close_timestamp,
    }),
    resolution: {
      kind: 'price',
      asset: proposal.asset.toUpperCase(),
      thresholdHuman: proposal.threshold,
      thresholdRaw: spec.threshold,
      decimals,
      direction: proposal.direction,
      reflector: feed.reflector,
    },
  };
}

// ─── Reveal ──────────────────────────────────────────────────────────────────

/**
 * Reveals a price spec after creation. `MarketAlreadyConfigured` (4) means a
 * previous attempt landed, so it counts as success.
 */
export async function revealPriceSpec(
  onChainMarketId: bigint,
  spec: Extract<ResolutionSpecJson, { kind: 'price' }>,
  deps: { register?: typeof registerPriceSpec } = {},
): Promise<WriteResult<void>> {
  validateResolutionSpec(spec, { forReveal: true });
  const call = deps.register ?? registerPriceSpec;
  try {
    return await call(onChainMarketId, toPriceConfig(spec));
  } catch (err) {
    if (err instanceof ChainError && err.contractError === 'MarketAlreadyConfigured') {
      return { mode: config.CHAIN_EXECUTION_MODE === 'live' ? 'live' : 'dry-run', method: 'register_price_spec', value: undefined, txHash: null };
    }
    throw err;
  }
}

export function toPriceConfig(spec: Extract<ResolutionSpecJson, { kind: 'price' }>): PriceConfig {
  return {
    reflector: spec.reflector,
    asset:
      spec.asset.kind === 'stellar'
        ? { tag: 'Stellar', values: [spec.asset.address] as const }
        : { tag: 'Other', values: [spec.asset.symbol] as const },
    threshold: BigInt(spec.threshold),
    direction: { tag: spec.direction, values: undefined },
    max_staleness: BigInt(spec.maxStaleness),
  };
}

// ─── Resolution loop ─────────────────────────────────────────────────────────

export const RESOLUTION_RETRY_CODES = new Set(['PriceUnavailable', 'StalePrice']);

export interface ResolutionAction {
  retry: boolean;
  escalate: boolean;
  delayMs: number;
}

/**
 * Retry/escalation policy for a single `resolve_price` failure. `PriceUnavailable`
 * and `StalePrice` are transient only until the deadline; after that a guardian
 * must decide (void the market). `MarketNotClosed` always retries (ledger time
 * may be behind). Everything else is terminal.
 */
export function nextResolutionAction(
  contractError: string | undefined,
  elapsedSecs: number,
  maxWaitSecs: number,
  attempt: number,
): ResolutionAction {
  if (contractError === 'MarketNotClosed' || contractError === 'AlreadyFinalized') {
    return { retry: true, escalate: false, delayMs: backoffMs(attempt) };
  }
  if (contractError && RESOLUTION_RETRY_CODES.has(contractError)) {
    if (elapsedSecs >= maxWaitSecs) return { retry: false, escalate: true, delayMs: 0 };
    return { retry: true, escalate: false, delayMs: backoffMs(attempt) };
  }
  return { retry: false, escalate: false, delayMs: 0 };
}

function backoffMs(attempt: number): number {
  return Math.min(config.CHAIN_RETRY_MAX_MS, config.CHAIN_RETRY_BASE_MS * 2 ** Math.min(attempt, 10));
}

export interface ResolutionTickDeps {
  resolve?: typeof resolvePrice;
  state?: typeof resolverState;
  now?: Date;
  markets?: Array<{ id: string; onChainMarketId: bigint | null; expiryTimestamp: Date; createdAt: Date }>;
}

/**
 * One pass of the 5-minute resolution cron. For each closed, price-mode market
 * that the resolver still has Unconfigured/pending, simulate `resolve_price`;
 * on the retryable codes back off up to PRICE_RESOLUTION_MAX_WAIT_SECS, then log
 * an ERROR `PRICE_RESOLUTION_STUCK` so a guardian can void the market.
 */
export async function runPriceResolutionTick(deps: ResolutionTickDeps = {}): Promise<{ resolved: bigint[]; escalated: bigint[] }> {
  const resolve = deps.resolve ?? resolvePrice;
  const state = deps.state ?? resolverState;
  const now = deps.now ?? new Date();
  const markets = deps.markets ?? [];
  const resolved: bigint[] = [];
  const escalated: bigint[] = [];

  for (const market of markets) {
    if (market.onChainMarketId === null) continue;
    const current = await state(market.onChainMarketId);
    if (current.tag === 'Finalized') continue;

    const elapsedSecs = Math.floor((now.getTime() - market.expiryTimestamp.getTime()) / 1000);
    let attempt = 0;
    for (;;) {
      try {
        await resolve(market.onChainMarketId);
        resolved.push(market.onChainMarketId);
        break;
      } catch (err) {
        const code = err instanceof ChainError ? err.contractError ?? undefined : undefined;
        if (code === 'AlreadyFinalized') break;
        const action = nextResolutionAction(code ?? undefined, elapsedSecs, config.PRICE_RESOLUTION_MAX_WAIT_SECS, attempt);
        if (!action.retry) {
          if (action.escalate) {
            escalated.push(market.onChainMarketId);
            await writeAgentLog({
              agentType: 'MARKET_MAKER',
              level: 'ERROR',
              action: 'PRICE_RESOLUTION_STUCK',
              marketId: market.id,
              data: { onChainMarketId: market.onChainMarketId.toString(), contractError: code ?? null, elapsedSecs },
            }).catch(() => undefined);
          }
          logger.warn({ marketId: market.id, code }, 'price resolution stopped');
          break;
        }
        if (attempt >= config.CHAIN_RETRY_MAX_ATTEMPTS) break;
        await new Promise((r) => setTimeout(r, action.delayMs));
        attempt++;
      }
    }
  }
  return { resolved, escalated };
}
