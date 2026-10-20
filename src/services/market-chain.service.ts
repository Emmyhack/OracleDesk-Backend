/**
 * Puts a database market on-chain through treasury.agent_create_market.
 *
 * ADR 0001: the market commits to its resolution rule at creation. We build
 * the spec, hash it exactly like scripts/spec-hash in the contracts repo,
 * store the full spec next to the market (so anyone can reveal it to
 * resolver.register_signer_spec later) and pass the hash on-chain.
 */
import { now as clockNow } from '../lib/clock';
import type { Market } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { toContractCategory, toContractCategoryValue } from '../lib/categories';
import { usdcFromNumber } from '../lib/amounts';
import { resolutionHash, type ResolutionSpecJson } from '../lib/resolution-spec';
import { writeAgentLog } from '../lib/agent-log';
import {
  agentCreateMarket,
  marketCoreConfig,
  treasuryAvailableCapital,
  treasuryConfig,
  treasuryDailyUsage,
  marketCount,
  ExpiredError,
  type WriteResult,
} from './chain.service';
import { ChainError, ChainPendingError } from './stellar/errors';
import { registerHandler, type ChainTransactionRow, type CompletionOutcome } from './stellar/outbox';
import { MIN_SEED_RAW, initialYesBps, decideSeed, type SeedDecision, type SeedPolicyConfig } from './seed-policy.service';
import { agentSigner } from './stellar/clients';
import { pinJson } from './ipfs.service';
import { revealPriceSpec } from './price-resolution.service';
import type { QuestionResolutionBlock } from './resolvability.service';
import { AppError } from '../middlewares/error.middleware';
import {
  claimCreation,
  discoverLandedMarket,
  linkLandedMarket,
  releaseClaim,
} from './market-idempotency.service';

// The seed policy owns both (it must stay free of config and database imports).
export { MIN_SEED_RAW, initialYesBps };

/**
 * Completion handler for `market.create` outbox rows (#35): links the landed
 * on-chain market id to the database market, whether confirmation arrived
 * inline or from the recovery worker after a crash. It never overwrites an
 * existing, different onChainMarketId — that would re-point live positions.
 */
export async function handleMarketCreateOutcome(row: ChainTransactionRow, outcome: CompletionOutcome): Promise<void> {
  const marketId = row.refId;
  if (!marketId) return;

  if (outcome.status !== 'SUCCESS') {
    await writeAgentLog({
      agentType: 'MARKET_MAKER',
      level: 'ERROR',
      action: 'MARKET_CREATION_FAILED',
      marketId,
      data: { outboxId: row.id, status: outcome.status, error: outcome.error ?? null, txHash: outcome.txHash ?? null },
    }).catch(() => undefined);
    return;
  }

  const onChainMarketId = BigInt(String(outcome.value ?? '0'));
  const existing = await prisma.market.findUnique({ where: { id: marketId }, select: { onChainMarketId: true } });
  if (!existing) return;
  if (existing.onChainMarketId != null) {
    if (existing.onChainMarketId !== onChainMarketId) {
      logger.error(
        { marketId, linked: existing.onChainMarketId.toString(), landed: onChainMarketId.toString(), outboxId: row.id },
        'market.create landed a different on-chain id than the one already linked; leaving the link untouched',
      );
    }
    return;
  }
  await linkLandedMarket(marketId, onChainMarketId, outcome.txHash ?? null);
}

registerHandler('market.create', handleMarketCreateOutcome);

export function defaultResolutionSpec(): ResolutionSpecJson {
  const signers = config.RESOLUTION_SIGNERS.length > 0
    ? config.RESOLUTION_SIGNERS
    : [agentSigner().publicKey as string];
  return {
    kind: 'signers',
    signers,
    threshold: config.RESOLUTION_THRESHOLD,
    disputeWindow: config.RESOLUTION_DISPUTE_WINDOW_SECS,
  };
}

/**
 * The question document pinned to IPFS; its sha256 is the on-chain question_hash.
 *
 * Version 2 (#74) adds a `resolution` block when the market has resolution
 * details. Markets without them keep the exact v1 shape, so their pinned bytes
 * (and hashes) are unchanged. Readers must ignore unknown fields.
 */
export function questionDocument(market: Market, resolutionHashHex: string, spec?: ResolutionSpecJson) {
  const details = market.resolutionDetails as QuestionResolutionBlock | null | undefined;
  const priceResolution =
    spec && spec.kind === 'price'
      ? {
          kind: 'price' as const,
          reflector: spec.reflector,
          asset: spec.asset.kind === 'stellar' ? spec.asset.address : spec.asset.symbol,
          assetKind: spec.asset.kind,
          threshold: spec.threshold,
          direction: spec.direction,
          maxStaleness: spec.maxStaleness,
        }
      : undefined;
  return {
    version: details ? 2 : 1,
    question: market.question,
    category: market.category,
    contractCategory: toContractCategory(market.category),
    closeTime: Math.floor(market.expiryTimestamp.getTime() / 1000),
    resolutionSource: market.resolutionOracle ?? null,
    resolutionHash: resolutionHashHex,
    backendMarketId: market.id,
    ...(details ? { resolution: details } : {}),
    ...(priceResolution ? { priceResolution } : {}),
  };
}

/** What the seed policy decided for a market, passed to createMarketOnChain. */
export interface SeedPlan {
  seedRaw: bigint;
  initialYesBps: number;
}

export interface SeedPlanInput {
  category: Market['category'];
  closeTime: Date;
  /** The model's initial YES probability and its confidence interval. */
  p: number;
  ci: { lower: number; upper: number };
  llmSuggestedSeedUsdc: number;
}

export function seedPolicyConfig(feeBps: number): SeedPolicyConfig {
  return {
    lpLossBudgetRaw: config.LP_LOSS_BUDGET_RAW,
    mmDailyShareBps: config.MM_DAILY_SHARE_BPS,
    maxSeedFractionBps: config.MAX_SEED_FRACTION_BPS,
    maxUnresolvedSeededRaw: config.MAX_UNRESOLVED_SEEDED_RAW,
    categoryBaseUsdc: config.SEED_CATEGORY_BASE_USDC,
    feeBps,
  };
}

// market-core's default_fee_bps is read once and cached: it is fixed at deployment.
let cachedFeeBps: number | null = null;
async function defaultFeeBps(): Promise<number> {
  if (cachedFeeBps === null) cachedFeeBps = Number((await marketCoreConfig()).default_fee_bps);
  return cachedFeeBps;
}

const DAY_SECS = 24n * 60n * 60n;

/**
 * Reads the treasury's risk config, its rolling daily usage and available
 * capital, plus what the backend already has locked in unresolved seeds. The
 * treasury's daily window starts at the first spend after the previous one
 * expired, so an expired window counts as zero usage.
 */
export async function readSeedBudget(now: Date) {
  const [risk, usage, availableRaw, feeBps] = await Promise.all([
    treasuryConfig(),
    treasuryDailyUsage(),
    treasuryAvailableCapital(),
    defaultFeeBps(),
  ]);
  const nowSecs = BigInt(Math.floor(now.getTime() / 1000));
  const windowLive = usage.day_start > 0n && nowSecs < usage.day_start + DAY_SECS;
  const windowStart = windowLive ? new Date(Number(usage.day_start) * 1000) : now;

  const [unresolved, seededInWindow] = await Promise.all([
    prisma.market.findMany({
      where: { status: { in: ['ACTIVE', 'PENDING', 'RESOLVING'] }, seedAmountRaw: { not: null } },
      select: { seedAmountRaw: true },
    }),
    windowLive
      ? prisma.market.findMany({
          where: { onChainMarketId: { not: null }, seedAmountRaw: { not: null }, createdAt: { gte: windowStart } },
          select: { seedAmountRaw: true },
        })
      : Promise.resolve([]),
  ]);
  const sum = (rows: Array<{ seedAmountRaw: string | null }>) => rows.reduce((acc, r) => acc + BigInt(r.seedAmountRaw ?? '0'), 0n);

  return {
    feeBps,
    unresolvedSeededRaw: sum(unresolved),
    budget: {
      availableRaw,
      maxTradeRaw: risk.max_trade,
      maxMarketRaw: risk.max_market,
      maxDailyRaw: risk.max_daily,
      dailyUsedRaw: windowLive ? usage.amount : 0n,
      mmSeededTodayRaw: sum(seededInWindow),
    },
  };
}

/**
 * Decides the seed and opening price for a proposal before anything is
 * pinned or written. A budget read failure fails closed: no seed, no market.
 */
export async function planMarketCreation(input: SeedPlanInput, now: Date = clockNow()): Promise<SeedDecision> {
  let read;
  try {
    read = await readSeedBudget(now);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Seed policy: treasury budget read failed; skipping creation');
    return { action: 'skip', reason: 'INSUFFICIENT_CAPITAL', inputs: { error: err instanceof Error ? err.message : String(err) } };
  }
  return decideSeed(
    {
      category: input.category,
      closeTime: input.closeTime,
      now,
      p: input.p,
      ci: input.ci,
      llmSuggestedSeedUsdc: input.llmSuggestedSeedUsdc,
      budget: read.budget,
      unresolvedSeededRaw: read.unresolvedSeededRaw,
    },
    seedPolicyConfig(read.feeBps),
  );
}

const CAP_RACE_ERRORS = new Set(['TradeCapExceeded', 'MarketCapExceeded', 'DailyCapExceeded']);

/**
 * Creates the market on-chain. With a `plan` (the normal path) the seed and
 * opening price come from the seed policy. Without one (admin tooling) the old
 * computation applies: the market's minimumLiquidity, floored at MIN_SEED.
 */
export async function createMarketOnChain(
  market: Market,
  spec: ResolutionSpecJson = defaultResolutionSpec(),
  plan?: SeedPlan,
): Promise<WriteResult<bigint>> {
  const resolutionHashBytes = resolutionHash(spec);
  const resolutionHashHex = resolutionHashBytes.toString('hex');
  const doc = questionDocument(market, resolutionHashHex, spec);
  const pinned = await pinJson(doc, `oracledesk-market-${market.id}`);

  // Abort if a re-pinned question document produces a hash different from stored (#41)
  if (market.questionHash && market.questionHash !== pinned.hash) {
    throw new AppError(409, 'QUESTION_HASH_MISMATCH', 'Re-pinned question document produced a hash different from stored questionHash');
  }

  // ── Dry-run path: claim and discover, but never move attempt past CLAIMED (#41) ──
  if (config.CHAIN_EXECUTION_MODE === 'dry-run') {
    const { acquired } = await claimCreation(market.id);
    try {
      await discoverLandedMarket({
        marketId: market.id,
        questionHashHex: pinned.hash,
        resolutionHashHex,
      });

      const requested = usdcFromNumber(market.minimumLiquidity);
      const seed = plan ? plan.seedRaw : requested < MIN_SEED_RAW ? MIN_SEED_RAW : requested;
      const openBps = plan ? plan.initialYesBps : initialYesBps(market.initialYesProb);

      const result = await agentCreateMarket({
        question_hash: Buffer.from(pinned.hash, 'hex'),
        resolution_hash: resolutionHashBytes,
        meta_uri: `ipfs://${pinned.cid}`,
        category: toContractCategoryValue(market.category),
        close_time: BigInt(Math.floor(market.expiryTimestamp.getTime() / 1000)),
        seed_amount: seed,
        initial_yes_bps: openBps,
      });

      logger.info(
        { marketId: market.id, simulatedMarketId: result.value.toString() },
        'Market creation simulated (dry-run); market stays PENDING',
      );
      return result;
    } finally {
      if (acquired) {
        await releaseClaim(market.id);
      }
    }
  }

  // ── Live path: atomic claim, discovery first, bounded retry (#41) ──
  const { acquired, attempt } = await claimCreation(market.id);
  if (!acquired && attempt?.status === 'CLAIMED') {
    logger.warn({ marketId: market.id }, 'Market creation currently claimed by another worker; skipping');
    throw new AppError(409, 'CREATION_ALREADY_CLAIMED', 'Market creation is currently claimed by another process');
  }

  // Always run discovery first before submitting
  const discoveredId = await discoverLandedMarket({
    marketId: market.id,
    questionHashHex: pinned.hash,
    resolutionHashHex,
    txHash: attempt?.tx_hash,
    preSubmissionCount: attempt?.pre_submission_market_count,
  });

  if (discoveredId !== null) {
    await linkLandedMarket(market.id, discoveredId, attempt?.tx_hash);
    return {
      mode: 'live',
      method: 'agent_create_market',
      value: discoveredId,
      txHash: attempt?.tx_hash ?? null,
    };
  }

  const requested = usdcFromNumber(market.minimumLiquidity);
  const seed = plan ? plan.seedRaw : requested < MIN_SEED_RAW ? MIN_SEED_RAW : requested;
  const openBps = plan ? plan.initialYesBps : initialYesBps(market.initialYesProb);

  await prisma.market.update({
    where: { id: market.id },
    data: {
      resolutionSpec: spec as object,
      resolutionHash: resolutionHashHex,
      questionHash: pinned.hash,
      metaUri: `ipfs://${pinned.cid}`,
      seedAmountRaw: seed.toString(),
    },
  });

  let preCount: bigint | null = null;
  try {
    preCount = await marketCount();
    await prisma.marketCreationAttempt.update({
      where: { marketId: market.id },
      data: {
        preSubmissionMarketCount: preCount,
        questionHash: pinned.hash,
        resolutionHash: resolutionHashHex,
        status: 'SUBMITTED',
      },
    });
  } catch {}

  let result: WriteResult<bigint>;
  try {
    result = await agentCreateMarket(
      {
        question_hash: Buffer.from(pinned.hash, 'hex'),
        resolution_hash: resolutionHashBytes,
        meta_uri: `ipfs://${pinned.cid}`,
        category: toContractCategoryValue(market.category),
        close_time: BigInt(Math.floor(market.expiryTimestamp.getTime() / 1000)),
        seed_amount: seed,
        initial_yes_bps: openBps,
      },
      undefined,
      { kind: 'market.create', refId: market.id },
    );
  } catch (err: any) {
    // Submitted but unconfirmed (#35): the outbox worker resolves the row and
    // the market.create handler links the market. The market stays PENDING and
    // the attempt keeps its SUBMITTED state with the hash for discovery (#41).
    if (err instanceof ChainPendingError) {
      await prisma.marketCreationAttempt.update({
        where: { marketId: market.id },
        data: { txHash: err.txHash ?? undefined },
      }).catch(() => undefined);
      logger.warn(
        { marketId: market.id, txHash: err.txHash, outboxId: err.outboxId },
        'Market creation submitted; awaiting confirmation via the outbox worker',
      );
      throw err;
    }

    const isExpired = err instanceof ExpiredError || err?.code === 'CHAIN_TX_EXPIRED';
    const txHash = err?.txHash ?? (err as any)?.details?.txHash ?? null;

    await prisma.marketCreationAttempt.update({
      where: { marketId: market.id },
      data: {
        status: isExpired ? 'EXPIRED' : 'UNKNOWN',
        txHash: txHash ?? undefined,
      },
    }).catch(() => undefined);

    // Run discovery immediately across ambiguous outcome
    try {
      const recoveredId = await discoverLandedMarket({
        marketId: market.id,
        questionHashHex: pinned.hash,
        resolutionHashHex,
        txHash,
        preSubmissionCount: preCount,
      });
      if (recoveredId !== null) {
        await linkLandedMarket(market.id, recoveredId, txHash);
        return {
          mode: 'live',
          method: 'agent_create_market',
          value: recoveredId,
          txHash,
        };
      }
    } catch {}

    if (err instanceof ChainError && err.contractError && CAP_RACE_ERRORS.has(err.contractError)) {
      await writeAgentLog({
        agentType: 'MARKET_MAKER', level: 'WARN', action: 'SEED_CAP_RACE', marketId: market.id,
        data: { contractError: err.contractError, seedRaw: seed.toString() },
      }).catch(() => undefined);
    }
    throw err;
  }

  if (result.mode === 'live') {
    // #35: the market.create completion handler linked the market (ACTIVE,
    // onChainMarketId, creationTxHash) before agentCreateMarket resolved.
    // Link directly when it could not run (e.g. injected chain deps or an
    // inline handler failure); linkLandedMarket re-applies the same values.
    const linked = await prisma.market.findUnique({ where: { id: market.id }, select: { onChainMarketId: true } });
    if (linked?.onChainMarketId == null) {
      await linkLandedMarket(market.id, result.value, result.txHash);
    }
    logger.info({ marketId: market.id, onChainMarketId: result.value.toString() }, 'Market created on-chain');

    // #90: a price market is unusable until its spec is revealed. Reveal right
    // after creation; on failure the periodic reveal pass retries, so the market
    // simply stays Unconfigured until then.
    if (spec.kind === 'price') {
      try {
        await revealPriceSpec(result.value, spec);
        logger.info({ marketId: market.id, onChainMarketId: result.value.toString() }, 'Price spec revealed');
      } catch (err) {
        await writeAgentLog({
          agentType: 'MARKET_MAKER', level: 'WARN', action: 'PRICE_SPEC_REVEAL_DEFERRED', marketId: market.id,
          data: { onChainMarketId: result.value.toString(), error: err instanceof Error ? err.message : String(err) },
        }).catch(() => undefined);
      }
    }
  } else {
    logger.info(
      { marketId: market.id, simulatedMarketId: result.value.toString() },
      'Market creation simulated (dry-run); market stays PENDING',
    );
  }
  return result;
}
