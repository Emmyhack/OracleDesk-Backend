/**
 * Stellar event indexer: polls RPC getEvents for the four OracleDesk
 * contracts, stores each event once (keyed by its RPC event id), applies
 * side effects, and publishes public events to the event bus (#93).
 *
 * - Publication is tied to the committed chain_events row: `published` flips
 *   to true only after the bus accepted the event, and publishPending()
 *   republishes whatever is still false, in (ledger, id) order. A crash
 *   between store and publish therefore loses nothing; a crash between the
 *   bus accepting the event and the flag republishes it, and the consumer
 *   drops the duplicate by id.
 *
 * - The ledger cursor is persisted in Postgres (indexer_cursors), so a
 *   restart resumes where it stopped.
 * - RPC only retains a short window of events. If the cursor is older than
 *   the oldest ledger RPC still has, we log a warning and resume from there;
 *   anything in between is lost to this indexer.
 * - Event shapes come from each binding's contract spec (Spec.parseEvent),
 *   never hand-written XDR decoding.
 */
import { rpc, xdr } from '@stellar/stellar-sdk';
import type { Spec } from '@stellar/stellar-sdk/contract';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { CONTRACTS } from '../config/contracts';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { newId, runWithContext } from '../lib/context';
import { readClients, rpcServer } from './stellar/clients';
import { disabledEventProjections } from './stellar/spec-compat';
import { printable } from './chain.service';
import { priceYesBps } from '../generated/fpmm';
import { withTimeout, deadline } from '../lib/resilience';
import { applyMarketFinality } from './market-finality';

export type EventSource = Pick<rpc.Server, 'getEvents' | 'getHealth'>;

/** Identity of the committed event a public message came from. */
export interface PublishMeta {
  /** chain_events.id */
  id: string;
  ledger: number;
  /** On-chain market id (decimal string) when the event belongs to a market. */
  marketKey: string | null;
}

export type PublishFn = (event: string, payload: unknown, meta: PublishMeta) => unknown;

export interface IndexerDeps {
  source: EventSource;
  /** Publishes a public event (to the event bus). Rejecting leaves the row unpublished. */
  emit: PublishFn;
}

const PAGE_LIMIT = 200;
export const CURSOR_ID = `stellar:${config.STELLAR_NETWORK_PASSPHRASE}`;

type ContractName = 'marketCore' | 'treasury' | 'resolver' | 'reasoningRegistry';

function specs(): Map<string, { name: ContractName; spec: Spec }> {
  return new Map<string, { name: ContractName; spec: Spec }>([
    [CONTRACTS.marketCore, { name: 'marketCore', spec: readClients.marketCore().spec }],
    [CONTRACTS.treasury, { name: 'treasury', spec: readClients.treasury().spec }],
    [CONTRACTS.resolver, { name: 'resolver', spec: readClients.resolver().spec }],
    [CONTRACTS.reasoningRegistry, { name: 'reasoningRegistry', spec: readClients.reasoningRegistry().spec }],
  ]);
}

export interface DecodedEvent {
  id: string;
  contractId: string;
  contractName: ContractName;
  eventName: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  params: Record<string, any>;
}

// One warning per key per process: a breaking spec change would otherwise
// repeat the same line on every poll.
const warned = new Set<string>();
function warnOnce(key: string, context: Record<string, unknown>, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(context, message);
}

/** Decodes one RPC event with its contract's spec; null for unknown events. */
export function decodeEvent(event: rpc.Api.EventResponse, known = specs()): DecodedEvent | null {
  const contractId = event.contractId?.contractId();
  if (!contractId) return null;
  const entry = known.get(contractId);
  if (!entry) return null;
  let parsed: ReturnType<Spec['parseEvent']>;
  try {
    parsed = entry.spec.parseEvent(event.topic as xdr.ScVal[], event.value);
  } catch (err) {
    // A deployed event whose shape drifted from the binding spec (#34) must
    // not abort the whole poll; the spec-compat report names the drift.
    warnOnce(
      `decode:${entry.name}`,
      { contract: entry.name, eventId: event.id, err: err instanceof Error ? err.message : String(err) },
      'Indexer: event does not decode with the binding spec (skipped; see /admin/chain/spec-compat)',
    );
    return null;
  }
  if (!parsed) return null;
  return {
    id: event.id,
    contractId,
    contractName: entry.name,
    eventName: parsed.name,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    txHash: event.txHash,
    params: parsed.data,
  };
}

/** Events that reach socket clients; every other stored event has nothing to publish. */
function hasPublicEvent(event: Pick<DecodedEvent, 'contractName' | 'eventName'>): boolean {
  return (
    (event.contractName === 'marketCore' && event.eventName === 'Trade') ||
    (event.contractName === 'reasoningRegistry' && event.eventName === 'TracePublished')
  );
}

/** Stores an event; returns false if it was already stored (idempotent). */
async function store(event: DecodedEvent, publishable = hasPublicEvent(event)): Promise<boolean> {
  try {
    await prisma.chainEvent.create({
      data: {
        id: event.id,
        contractId: event.contractId,
        contractName: event.contractName,
        eventName: event.eventName,
        ledger: event.ledger,
        ledgerClosedAt: new Date(event.ledgerClosedAt),
        txHash: event.txHash,
        params: printable(event.params) as Prisma.InputJsonValue,
        published: !publishable,
      },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    throw err;
  }
}

const outcomeTag = (o: unknown): 'Yes' | 'No' | null =>
  o && typeof o === 'object' && 'tag' in o ? ((o as { tag: 'Yes' | 'No' }).tag) : null;

async function applySideEffects(event: DecodedEvent): Promise<void> {
  const p = event.params;

  if (event.contractName === 'marketCore' && event.eventName === 'Trade') {
    const onChainMarketId = BigInt(p.market_id);
    const yesBps = Number(priceYesBps(BigInt(p.reserve_yes), BigInt(p.reserve_no)));
    const market = await prisma.market.findUnique({ where: { onChainMarketId }, select: { id: true, question: true } });
    if (market) {
      // Only a newer (or same-ledger) observation may move the price: the
      // reconciler may already have written a later one.
      await prisma.market.updateMany({
        where: { id: market.id, OR: [{ chainSyncedLedger: null }, { chainSyncedLedger: { lte: event.ledger } }] },
        data: { currentYesProb: yesBps / 10_000, chainSyncedLedger: event.ledger },
      });
    }
    if (Boolean(p.is_buy)) {
      try {
        const { reconcileFromTradeEvent } = await import('./copy-trade.service');
        await reconcileFromTradeEvent(event);
      } catch (err) {
        logger.error({ err, eventId: event.id }, 'Indexer: copy trade reconciliation failed');
      }
    }

    return;
  }

  if (event.contractName === 'marketCore' && event.eventName === 'MarketResolved') {
    const onChainMarketId = BigInt(p.market_id);
    const outcome = outcomeTag(p.outcome); // null: the market was voided
    const market = await prisma.market.findUnique({ where: { onChainMarketId }, select: { id: true } });
    if (!market) return;
    await applyMarketFinality(market.id, outcome, new Date(event.ledgerClosedAt), event.ledger);
    return;
  }

  // #92: a signer proposal opens a dispute review. The independent evaluation
  // and its alerts run after this poll tick (scheduleReview), never inside it.
  if (event.contractName === 'resolver' && event.eventName === 'ResolutionProposed') {
    if (!config.DISPUTE_MONITOR_ENABLED) return;
    const monitor = await import('./dispute-monitor.service');
    const { review, created } = await monitor.recordProposal(event);
    if (created) monitor.scheduleReview(review.id);
    return;
  }

  if (event.contractName === 'resolver' && event.eventName === 'ResolutionFinalized') {
    if (!config.DISPUTE_MONITOR_ENABLED) return;
    const monitor = await import('./dispute-monitor.service');
    await monitor.recordFinalized(event);
    return;
  }

  if (event.contractName === 'reasoningRegistry' && event.eventName === 'TracePublished') {
    const traceHash =
      typeof p.trace_hash === 'string'
        ? p.trace_hash
        : Buffer.from(p.trace_hash).toString('hex');
    const onChainTraceId = BigInt(p.trace_id);
    const onChainMarketId = BigInt(p.market_id);
    const trace = await prisma.reasoningTrace.findFirst({
      where: {
        traceHash,
        market: { onChainMarketId },
      },
      select: { id: true, onChainTraceId: true },
    });
    if (trace && (trace.onChainTraceId === null || trace.onChainTraceId === onChainTraceId)) {
      // The event's trace_hash equals our stored traceHash, which is exactly
      // what verification means for our own traces (#131). RPC reports a
      // fee-bumped transaction by its outer hash, so resolve the inner hash
      // from the outbox by any known hash (#38).
      const innerTxHash = await import('./stellar/outbox')
        .then((m) => m.innerHashForTx(event.txHash))
        .catch(() => null);
      if (trace.onChainTraceId === null) {
        await prisma.reasoningTrace.update({
          where: { id: trace.id },
          data: {
            onChainTraceId,
            publishTxHash: event.txHash,
            ...(innerTxHash && innerTxHash !== event.txHash ? { publishInnerTxHash: innerTxHash } : {}),
            verified: true,
          },
        });
      } else {
        await prisma.reasoningTrace.update({ where: { id: trace.id }, data: { verified: true } });
      }
      await prisma.tracePublication.updateMany({
        where: { traceId: trace.id, status: { in: ['AWAITING_MARKET', 'READY', 'SUBMITTED'] } },
        data: { status: 'CONFIRMED', confirmedAt: new Date(), lastError: null },
      });
    }
  }
}

export interface PublicEvent {
  type: 'TRADE_EXECUTED' | 'REASONING_PUBLISHED';
  payload: Record<string, unknown>;
  marketKey: string | null;
}

/**
 * The socket message for a stored event, or null when it has none. Built from
 * the stored event plus current database state, so the live path and the
 * recovery path (publishPending) produce the same payload.
 */
export async function publicEventFor(event: DecodedEvent): Promise<PublicEvent | null> {
  const p = event.params;

  if (event.contractName === 'marketCore' && event.eventName === 'Trade') {
    const onChainMarketId = BigInt(p.market_id);
    const yesBps = Number(priceYesBps(BigInt(p.reserve_yes), BigInt(p.reserve_no)));
    const market = await prisma.market.findUnique({ where: { onChainMarketId }, select: { id: true, question: true } });
    return {
      type: 'TRADE_EXECUTED',
      marketKey: onChainMarketId.toString(),
      payload: {
        onChainMarketId: onChainMarketId.toString(),
        marketId: market?.id ?? null,
        marketQuestion: market?.question ?? null,
        trader: p.trader,
        direction: outcomeTag(p.outcome) === 'No' ? 'NO' : 'YES',
        isBuy: Boolean(p.is_buy),
        collateralRaw: String(p.collateral),
        sharesRaw: String(p.shares),
        feeRaw: String(p.fee),
        priceYesBps: yesBps,
        txHash: event.txHash,
        ledger: event.ledger,
        eventId: event.id,
      },
    };
  }

  if (event.contractName === 'reasoningRegistry' && event.eventName === 'TracePublished') {
    const traceHash =
      typeof p.trace_hash === 'string' ? p.trace_hash : Buffer.from(p.trace_hash).toString('hex');
    const onChainMarketId = BigInt(p.market_id);
    const trace = await prisma.reasoningTrace.findFirst({
      where: { traceHash, market: { onChainMarketId } },
      select: { id: true },
    });
    return {
      type: 'REASONING_PUBLISHED',
      marketKey: onChainMarketId.toString(),
      payload: {
        onChainTraceId: BigInt(p.trace_id).toString(),
        onChainMarketId: String(p.market_id),
        traceId: trace?.id ?? null,
        agent: p.agent,
        action: p.action,
        ipfsCid: p.ipfs_cid,
        traceHash,
        txHash: event.txHash,
        ledger: event.ledger,
      },
    };
  }

  return null;
}

const PUBLISH_BATCH = 200;

// The live path and the recovery loop both go through this queue, so they can
// never publish concurrently and (ledger, id) order holds within one instance.
let publishQueue: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = publishQueue.then(fn, fn);
  publishQueue = run.catch(() => undefined);
  return run;
}

/**
 * Publishes every stored event with published = false, oldest first, flagging
 * each one after the bus accepted it. Stops at the first failure so a later
 * event never overtakes an earlier one; the next call retries from there.
 */
export function publishPending(emit: PublishFn): Promise<{ published: number; failed: boolean }> {
  return serialised(async () => {
    let published = 0;
    for (;;) {
      const rows = await prisma.chainEvent.findMany({
        where: { published: false },
        orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
        take: PUBLISH_BATCH,
      });
      for (const row of rows) {
        try {
          const decoded = decodedFromStored(row);
          const pub = await publicEventFor(decoded);
          if (pub) await emit(pub.type, pub.payload, { id: row.id, ledger: row.ledger, marketKey: pub.marketKey });
          await prisma.chainEvent.update({ where: { id: row.id }, data: { published: true } });
          published++;
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : err, eventId: row.id },
            'Indexer: publishing failed; will retry from this event',
          );
          return { published, failed: true };
        }
      }
      if (rows.length < PUBLISH_BATCH) return { published, failed: false };
    }
  });
}

async function readCursor(): Promise<number | null> {
  const row = await prisma.indexerCursor.findUnique({ where: { id: CURSOR_ID } });
  return row ? row.lastLedger : null;
}

async function writeCursor(lastLedger: number): Promise<void> {
  await prisma.indexerCursor.upsert({
    where: { id: CURSOR_ID },
    create: { id: CURSOR_ID, lastLedger },
    update: { lastLedger },
  });
}

/**
 * Indexes from `fromLedger` (default: the stored cursor + 1, or the oldest
 * ledger RPC retains) up to the latest ledger. Returns counts.
 */
export async function backfillEvents(
  fromLedger?: number,
  deps: IndexerDeps = { source: rpcServer, emit: () => undefined },
  opts?: { signal?: AbortSignal },
): Promise<{ startLedger: number; lastLedger: number; seen: number; stored: number }> {
  const tickLimitMs = Math.floor(config.CYCLE_DEADLINE_MS / 10);
  const handle = deadline('rpc-events', opts?.signal, tickLimitMs);

  try {
    const health = await withTimeout('rpc-events', async () => deps.source.getHealth(), { signal: handle.signal });
    const cursor = await readCursor();
    let startLedger = fromLedger ?? (cursor !== null ? cursor + 1 : health.oldestLedger);

    if (startLedger < health.oldestLedger) {
      logger.warn(
        { requested: startLedger, oldestAvailable: health.oldestLedger },
        'Indexer cursor is older than RPC retention; resuming from the oldest available ledger. Events in between are not indexed.',
      );
      startLedger = health.oldestLedger;
    }
    if (startLedger > health.latestLedger) {
      return { startLedger, lastLedger: cursor ?? health.latestLedger, seen: 0, stored: 0 };
    }

    const known = specs();
    const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [...known.keys()] }];
    let seen = 0;
    let stored = 0;
    let latestLedger = health.latestLedger;
    let page = await withTimeout(
      'rpc-events',
      async () => deps.source.getEvents({ startLedger, filters, limit: PAGE_LIMIT }),
      { signal: handle.signal },
    );

    for (;;) {
      latestLedger = page.latestLedger;
      for (const raw of page.events) {
        seen++;
        const decoded = decodeEvent(raw, known);
        if (!decoded) continue;
        // #34: an event whose deployed spec has a breaking change is still
        // stored, but no longer projected or published — its decoded params
        // can no longer be trusted to match what the binding promised.
        const key = `${decoded.contractName}:${decoded.eventName}`;
        const projectable = !disabledEventProjections().has(key);
        if (!projectable) {
          warnOnce(
            `project:${key}`,
            { contract: decoded.contractName, event: decoded.eventName },
            'Indexer: projections disabled for this event (breaking spec change; see /admin/chain/spec-compat)',
          );
        }
        if (await store(decoded, projectable && hasPublicEvent(decoded))) {
          stored++;
          // #35: an indexed event proves its transaction landed. A matching
          // non-terminal outbox row resolves now instead of on the next poll.
          await import('./stellar/outbox')
            .then((m) => m.recoverByTxHash(decoded.txHash))
            .catch((err) =>
              logger.warn({ err: err instanceof Error ? err.message : err, txHash: decoded.txHash }, 'Indexer: outbox recovery by txHash failed'),
            );
          if (projectable) {
            await applySideEffects(decoded).catch((err) =>
              logger.error({ err, eventId: decoded.id }, 'Indexer side effect failed'),
            );
          }
        }
      }
      if (page.events.length < PAGE_LIMIT) break;
      page = await withTimeout(
        'rpc-events',
        async () => deps.source.getEvents({ filters, cursor: page.cursor, limit: PAGE_LIMIT }),
        { signal: handle.signal },
      );
    }

    await writeCursor(latestLedger);
    // Also covers rows left unpublished by an earlier outage, not just this run's.
    await publishPending(deps.emit).catch((err) =>
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Indexer: publish pass failed'),
    );
    if (stored > 0) logger.info({ startLedger, lastLedger: latestLedger, seen, stored }, 'Indexed Stellar events');
    return { startLedger, lastLedger: latestLedger, seen, stored };
  } finally {
    handle.cleanup?.();
  }
}

/**
 * Re-applies one stored event's projections (#146). Unlike the normal path it
 * does not insert the event first, so a restore can rebuild projections for
 * rows that survived the backup. Callers replay in (ledger, id) order.
 */
export async function reprojectEvent(event: DecodedEvent): Promise<void> {
  await applySideEffects(event);
}

/** Converts a stored row back into the decoded shape used by applySideEffects. */
export function decodedFromStored(row: {
  id: string;
  contractId: string;
  contractName: string;
  eventName: string;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  params: unknown;
}): DecodedEvent {
  return {
    id: row.id,
    contractId: row.contractId,
    contractName: row.contractName as ContractName,
    eventName: row.eventName,
    ledger: row.ledger,
    ledgerClosedAt: row.ledgerClosedAt.toISOString(),
    txHash: row.txHash,
    params: row.params as Record<string, any>,
  };
}

// Poll state for health reporting (#111); module-level because one indexer runs per process.
const pollState: { lastLedger: number | null; updatedAt: string | null; lastPollAt: string | null; lastPollError: string | null } = {
  lastLedger: null,
  updatedAt: null,
  lastPollAt: null,
  lastPollError: null,
};

export function indexerStatus() {
  return { enabled: config.INDEXER_ENABLED, ...pollState };
}

/** Polls every INDEXER_POLL_MS. Returns a stop function. */
export function startEventListener(emit: IndexerDeps['emit']): () => void {
  if (!config.INDEXER_ENABLED) {
    logger.warn('INDEXER_ENABLED=false; Stellar event indexer disabled');
    return () => undefined;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    try {
      const result = await backfillEvents(undefined, { source: rpcServer, emit });
      pollState.lastLedger = result.lastLedger;
      pollState.updatedAt = new Date().toISOString();
      pollState.lastPollError = null;
    } catch (err) {
      pollState.lastPollError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Indexer poll failed; will retry');
    }
    pollState.lastPollAt = new Date().toISOString();
    if (!stopped) timer = setTimeout(tick, config.INDEXER_POLL_MS);
  };
  void tick();
  logger.info({ pollMs: config.INDEXER_POLL_MS }, 'Stellar event indexer started');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
