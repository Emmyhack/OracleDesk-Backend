/**
 * Periodic drift job between the database's market lifecycle and market-core
 * (#83). It walks linked markets in bounded batches, reads
 * `market_core.get_market` with the ledger the simulation ran against,
 * classifies each difference, repairs the safe classes and reports the rest.
 *
 * It never fights the indexer: every write is conditional on the row's
 * `chainSyncedLedger`, resolution-class findings are deferred while the
 * indexer is behind the observation, and finality goes through the same
 * `applyMarketFinality` the indexer uses.
 */
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { writeAgentLog } from '../lib/agent-log';
import { withAdvisoryLock } from '../lib/advisory-lock';
import { priceYesBps } from '../generated/fpmm';
import type { Market as OnChainMarket } from '../generated/market-core';
import { ChainError } from './stellar/errors';
import { getOnChainMarketWithLedger } from './chain.service';
import { rpcServer } from './stellar/clients';
import { CURSOR_ID } from './indexer.service';
import { applyMarketFinality } from './market-finality';

export const RECONCILE_LOCK = 'market-reconciler';
/** close_time is ledger time; allow this much slack between ledger and observation. */
export const CLOSE_GRACE_MS = 60_000;
export const PRICE_TOLERANCE = 0.005;
/** A resolution-class finding deferred this many runs in a row is repaired anyway. */
export const MAX_CONSECUTIVE_DEFERRALS = 2;

export type DriftClass =
  | 'MISSED_RESOLUTION'
  | 'MISSED_VOID'
  | 'CLOSED_BUT_ACTIVE'
  | 'PRICE_STALE'
  | 'CLOSE_TIME_MISMATCH'
  | 'HASH_MISMATCH'
  | 'NOT_FOUND_ON_CHAIN'
  | 'STATUS_REGRESSION';

export type DriftAction = 'REPAIRED' | 'REPORTED' | 'DEFERRED' | 'SKIPPED_NEWER';

export interface MarketRow {
  id: string;
  status: string;
  onChainMarketId: bigint;
  currentYesProb: number | null;
  expiryTimestamp: Date;
  questionHash: string | null;
  resolutionHash: string | null;
  metaUri: string | null;
}

export interface DriftFinding {
  driftClass: DriftClass;
  dbValue: unknown;
  chainValue: unknown;
}

const FINAL = new Set(['RESOLVED', 'CANCELLED']);
const hex = (b: Buffer | Uint8Array | string) => (typeof b === 'string' ? b : Buffer.from(b).toString('hex'));

/** Classes that mean "the chain is final or closed and the row is not": deferred while the indexer is behind. */
const RESOLUTION_CLASS = new Set<DriftClass>(['MISSED_RESOLUTION', 'MISSED_VOID', 'CLOSED_BUT_ACTIVE']);
/** Classes that are integrity incidents: never repaired, always logged at ERROR. */
const INTEGRITY_CLASS = new Set<DriftClass>(['HASH_MISMATCH', 'STATUS_REGRESSION', 'NOT_FOUND_ON_CHAIN']);

/**
 * Pure classification of one row against its chain state. `ledgerTime` is the
 * close time of the observation ledger (close_time is ledger time, not
 * wall-clock).
 */
export function classifyDrift(row: MarketRow, chain: OnChainMarket, _obsLedger: number, ledgerTime: Date): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const status = chain.status;
  const dbFinal = FINAL.has(row.status);

  if (status.tag === 'Resolved') {
    const outcome = status.values[0].tag;
    if (!dbFinal) findings.push({ driftClass: 'MISSED_RESOLUTION', dbValue: { status: row.status }, chainValue: { status: 'Resolved', outcome } });
    else if (row.status !== 'RESOLVED') findings.push({ driftClass: 'STATUS_REGRESSION', dbValue: { status: row.status }, chainValue: { status: 'Resolved', outcome } });
  } else if (status.tag === 'Void') {
    if (!dbFinal) findings.push({ driftClass: 'MISSED_VOID', dbValue: { status: row.status }, chainValue: { status: 'Void' } });
    else if (row.status !== 'CANCELLED') findings.push({ driftClass: 'STATUS_REGRESSION', dbValue: { status: row.status }, chainValue: { status: 'Void' } });
  } else {
    // Chain says Open.
    if (dbFinal) {
      // Likely a network reset or a wrong link; never repaired.
      findings.push({ driftClass: 'STATUS_REGRESSION', dbValue: { status: row.status }, chainValue: { status: 'Open' } });
    } else {
      if (row.status === 'ACTIVE' && Number(chain.close_time) * 1000 + CLOSE_GRACE_MS <= ledgerTime.getTime()) {
        findings.push({ driftClass: 'CLOSED_BUT_ACTIVE', dbValue: { status: row.status }, chainValue: { status: 'Open', closeTime: Number(chain.close_time), ledgerTime: ledgerTime.toISOString() } });
      }
      const chainProb = Number(priceYesBps(chain.reserve_yes, chain.reserve_no)) / 10_000;
      if (row.currentYesProb === null || Math.abs(chainProb - row.currentYesProb) > PRICE_TOLERANCE) {
        findings.push({ driftClass: 'PRICE_STALE', dbValue: { currentYesProb: row.currentYesProb }, chainValue: { currentYesProb: chainProb } });
      }
    }
  }

  const expiry = Math.floor(row.expiryTimestamp.getTime() / 1000);
  if (Number(chain.close_time) !== expiry) {
    findings.push({ driftClass: 'CLOSE_TIME_MISMATCH', dbValue: { expiryTimestamp: expiry }, chainValue: { closeTime: Number(chain.close_time) } });
  }

  const db: Record<string, string> = {};
  const onChain: Record<string, string> = {};
  const compare = (field: string, rowValue: string | null, chainValue: string) => {
    if (rowValue !== null && rowValue.toLowerCase() !== chainValue.toLowerCase()) {
      db[field] = rowValue;
      onChain[field] = chainValue;
    }
  };
  compare('questionHash', row.questionHash, hex(chain.question_hash));
  compare('resolutionHash', row.resolutionHash, hex(chain.resolution_hash));
  compare('metaUri', row.metaUri, chain.meta_uri);
  if (Object.keys(db).length > 0) findings.push({ driftClass: 'HASH_MISMATCH', dbValue: db, chainValue: onChain });

  return findings;
}

export interface ReconcileOptions {
  maxMarkets: number;
  concurrency: number;
  dryRun: boolean;
  now: Date;
  /** Pre-assigned run id (the admin endpoint returns it before the run finishes). */
  runId?: string;
  maxRpcCalls?: number;
}

export interface ReconcileRunSummary {
  runId: string;
  scanned: number;
  repaired: number;
  reported: number;
  deferred: number;
  skippedNewer: number;
  rpcCalls: number;
  rpcErrors: number;
}

export interface ReconcilerDeps {
  fetchMarket(onChainMarketId: bigint): Promise<{ market: OnChainMarket; ledger: number }>;
  /** Close time of the run's reference ledger. */
  ledgerCloseTime(): Promise<Date>;
  indexerCursor(): Promise<number | null>;
  indexerEnabled(): boolean;
  emit?: (event: string, payload: unknown) => void;
}

async function defaultLedgerCloseTime(): Promise<Date> {
  try {
    const latest = await rpcServer.getLatestLedger();
    const res = await rpcServer.getLedgers({ startLedger: latest.sequence, pagination: { limit: 1 } });
    if (res.latestLedgerCloseTime) return new Date(Number(res.latestLedgerCloseTime) * 1000);
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err }, 'Reconciler: ledger close time unavailable; approximating');
  }
  // Approximation (documented in docs/architecture.md): the newest indexed event's ledger time, else the wall clock.
  const newest = await prisma.chainEvent.findFirst({ orderBy: { ledger: 'desc' }, select: { ledgerClosedAt: true } }).catch(() => null);
  return newest?.ledgerClosedAt ?? new Date();
}

export const defaultDeps: ReconcilerDeps = {
  fetchMarket: (id) => getOnChainMarketWithLedger(id),
  ledgerCloseTime: defaultLedgerCloseTime,
  indexerCursor: async () => (await prisma.indexerCursor.findUnique({ where: { id: CURSOR_ID } }))?.lastLedger ?? null,
  indexerEnabled: () => config.INDEXER_ENABLED,
};

const OPEN_STATUSES = ['ACTIVE', 'RESOLVING', 'PENDING'] as const;
const FINAL_STATUSES = ['RESOLVED', 'CANCELLED'] as const;

async function selectMarkets(max: number): Promise<MarketRow[]> {
  const select = {
    id: true, status: true, onChainMarketId: true, currentYesProb: true, expiryTimestamp: true,
    questionHash: true, resolutionHash: true, metaUri: true,
  } as const;
  const order = [{ lastReconciledAt: { sort: 'asc', nulls: 'first' } }] as const;
  const open = await prisma.market.findMany({
    where: { onChainMarketId: { not: null }, status: { in: [...OPEN_STATUSES] } },
    orderBy: order as any,
    select,
    take: max,
  });
  const room = max - open.length;
  const final = room > 0
    ? await prisma.market.findMany({
        where: { onChainMarketId: { not: null }, status: { in: [...FINAL_STATUSES] } },
        orderBy: order as any,
        select,
        take: room,
      })
    : [];
  return [...open, ...final] as MarketRow[];
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

interface ReportRow {
  runId: string;
  marketId: string;
  onChainMarketId: bigint;
  driftClass: DriftClass;
  dbValue: unknown;
  chainValue: unknown;
  action: DriftAction;
  observedLedger: number;
}

const notNewer = (ledger: number) => ({ OR: [{ chainSyncedLedger: null }, { chainSyncedLedger: { lt: ledger } }] });

export async function reconcileMarkets(opts: ReconcileOptions, deps: ReconcilerDeps = defaultDeps): Promise<ReconcileRunSummary> {
  const runId = opts.runId ?? uuidv4();
  const maxRpc = opts.maxRpcCalls ?? config.RECONCILE_MAX_RPC_CALLS;
  const summary: ReconcileRunSummary = { runId, scanned: 0, repaired: 0, reported: 0, deferred: 0, skippedNewer: 0, rpcCalls: 0, rpcErrors: 0 };
  await prisma.reconcileRun.create({ data: { id: runId, startedAt: opts.now } });

  const reports: ReportRow[] = [];
  const reconciled: string[] = [];
  let failure: string | undefined;

  try {
    const rows = await selectMarkets(opts.maxMarkets);
    const [ledgerTime, cursor] = await Promise.all([deps.ledgerCloseTime(), deps.indexerCursor()]);
    const indexerOn = deps.indexerEnabled();

    await pool(rows, opts.concurrency, async (row) => {
      if (summary.rpcCalls >= maxRpc) return; // budget spent; the rest are picked first next run
      summary.rpcCalls++;

      let observed: { market: OnChainMarket; ledger: number };
      try {
        observed = await deps.fetchMarket(row.onChainMarketId);
      } catch (err) {
        if (err instanceof ChainError && err.contractError === 'MarketNotFound') {
          summary.scanned++;
          reconciled.push(row.id);
          reports.push({
            runId, marketId: row.id, onChainMarketId: row.onChainMarketId, driftClass: 'NOT_FOUND_ON_CHAIN',
            dbValue: { status: row.status }, chainValue: null, action: 'REPORTED', observedLedger: 0,
          });
          return;
        }
        // Other RPC errors are not drift: count and skip.
        summary.rpcErrors++;
        logger.warn({ marketId: row.id, err: err instanceof Error ? err.message : err }, 'Reconciler: chain read failed; skipping market');
        return;
      }

      summary.scanned++;
      reconciled.push(row.id);
      const { market, ledger } = observed;
      const findings = classifyDrift(row, market, ledger, ledgerTime);
      if (findings.length === 0) return;

      const base = { runId, marketId: row.id, onChainMarketId: row.onChainMarketId, observedLedger: ledger };
      const report = (f: DriftFinding, action: DriftAction, extra?: Record<string, unknown>) =>
        reports.push({ ...base, driftClass: f.driftClass, dbValue: f.dbValue, chainValue: extra ? { ...(f.chainValue as object), ...extra } : f.chainValue, action });

      const hasHashMismatch = findings.some((f) => f.driftClass === 'HASH_MISMATCH');
      const indexerBehind = indexerOn && cursor !== null && ledger > cursor + config.RECONCILE_INDEXER_LAG_LEDGERS;
      const toRepair: Array<{ f: DriftFinding; forced: boolean }> = [];

      for (const f of findings) {
        if (opts.dryRun || INTEGRITY_CLASS.has(f.driftClass)) {
          report(f, 'REPORTED');
        } else if (f.driftClass === 'CLOSE_TIME_MISMATCH' && hasHashMismatch) {
          // Possibly a mislinked row: never repair close time next to a hash mismatch.
          report(f, 'REPORTED');
        } else if (RESOLUTION_CLASS.has(f.driftClass) && indexerBehind) {
          // The indexer may be about to process the event itself: defer, but not forever.
          const prior = await prisma.marketDriftReport.findMany({
            where: { marketId: row.id, driftClass: f.driftClass },
            orderBy: { createdAt: 'desc' },
            take: MAX_CONSECUTIVE_DEFERRALS,
          });
          const forced = prior.length === MAX_CONSECUTIVE_DEFERRALS && prior.every((p) => p.action === 'DEFERRED');
          if (forced) toRepair.push({ f, forced: true });
          else report(f, 'DEFERRED');
        } else {
          toRepair.push({ f, forced: false });
        }
      }

      // Finality supersedes every other repair for this market in this run.
      const finality = toRepair.find(({ f }) => f.driftClass === 'MISSED_RESOLUTION' || f.driftClass === 'MISSED_VOID');
      if (finality) {
        const ok = await applyRepairs(row, market, ledger, ledgerTime, [], finality.f);
        // The exact resolution time is unknown: resolvedAt is the observation time.
        report(finality.f, ok ? 'REPAIRED' : 'SKIPPED_NEWER', { resolvedAtApproximate: true, ...(finality.forced ? { forced: true } : {}) });
      } else if (toRepair.length > 0) {
        const ok = await applyRepairs(row, market, ledger, ledgerTime, toRepair.map((r) => r.f), null);
        for (const { f, forced } of toRepair) report(f, ok ? 'REPAIRED' : 'SKIPPED_NEWER', forced ? { forced: true } : undefined);
      }
    });

    if (reports.length > 0) {
      await prisma.marketDriftReport.createMany({
        data: reports.map((r) => ({ ...r, dbValue: r.dbValue as object, chainValue: (r.chainValue ?? {}) as object })),
      });
    }
    if (!opts.dryRun && reconciled.length > 0) {
      await prisma.market.updateMany({ where: { id: { in: reconciled } }, data: { lastReconciledAt: opts.now } });
    }

    for (const r of reports) {
      if (r.action === 'REPAIRED') summary.repaired++;
      else if (r.action === 'DEFERRED') summary.deferred++;
      else if (r.action === 'SKIPPED_NEWER') summary.skippedNewer++;
      else summary.reported++;
    }

    for (const r of reports.filter((x) => INTEGRITY_CLASS.has(x.driftClass))) {
      await writeAgentLog({
        agentType: 'MARKET_MAKER', level: 'ERROR', action: 'MARKET_INTEGRITY_DRIFT', marketId: r.marketId,
        data: { runId, driftClass: r.driftClass, dbValue: r.dbValue, chainValue: r.chainValue, observedLedger: r.observedLedger },
      }).catch((err) => logger.error({ err }, 'Reconciler: failed to write the integrity log'));
      deps.emit?.('MARKET_DRIFT', {
        runId, marketId: r.marketId, onChainMarketId: r.onChainMarketId.toString(), driftClass: r.driftClass,
        dbValue: r.dbValue, chainValue: r.chainValue,
      });
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await prisma.reconcileRun.update({
      where: { id: runId },
      data: {
        finishedAt: new Date(), scanned: summary.scanned, repaired: summary.repaired, reported: summary.reported,
        deferred: summary.deferred, rpcCalls: summary.rpcCalls, error: failure ?? null,
      },
    }).catch((err) => logger.error({ err }, 'Reconciler: failed to close the run record'));
  }

  logger.info({ ...summary, dryRun: opts.dryRun }, 'Market reconciliation finished');
  return summary;
}

/**
 * Applies repairs for one market in a single guarded write, so the
 * chainSyncedLedger bump from the first field cannot block the others.
 * Returns false when a newer writer already moved the row.
 */
async function applyRepairs(
  row: MarketRow,
  market: OnChainMarket,
  ledger: number,
  ledgerTime: Date,
  repairs: DriftFinding[],
  finality: DriftFinding | null,
): Promise<boolean> {
  if (finality) {
    const outcome = finality.driftClass === 'MISSED_VOID' ? null : (market.status.tag === 'Resolved' ? market.status.values[0].tag : null);
    // The exact resolution time is unknown; the observation time stands in for it.
    return applyMarketFinality(row.id, outcome, ledgerTime, ledger);
  }
  const data: Record<string, unknown> = { chainSyncedLedger: ledger };
  for (const f of repairs) {
    if (f.driftClass === 'CLOSED_BUT_ACTIVE') data.status = 'RESOLVING';
    else if (f.driftClass === 'PRICE_STALE') data.currentYesProb = (f.chainValue as { currentYesProb: number }).currentYesProb;
    else if (f.driftClass === 'CLOSE_TIME_MISMATCH') data.expiryTimestamp = new Date(Number(market.close_time) * 1000);
  }
  const where: Record<string, unknown> = { id: row.id, ...notNewer(ledger) };
  if (data.status) where.status = 'ACTIVE';
  const res = await prisma.market.updateMany({ where, data });
  return res.count > 0;
}

/**
 * One reconciliation run behind the cross-instance advisory lock. A run that
 * cannot take the lock records itself as skipped, so a pre-assigned run id
 * always resolves.
 */
export async function runReconciliation(
  overrides: Partial<ReconcileOptions> = {},
  deps: ReconcilerDeps = defaultDeps,
): Promise<ReconcileRunSummary | null> {
  const runId = overrides.runId ?? uuidv4();
  const opts: ReconcileOptions = {
    maxMarkets: config.RECONCILE_MAX_MARKETS,
    concurrency: config.RECONCILE_CONCURRENCY,
    dryRun: false,
    now: new Date(),
    ...overrides,
    runId,
  };
  const result = await withAdvisoryLock(RECONCILE_LOCK, () => reconcileMarkets(opts, deps));
  if (result.acquired) return result.value;
  await prisma.reconcileRun.create({
    data: { id: runId, startedAt: opts.now, finishedAt: new Date(), error: 'another instance is reconciling; run skipped' },
  }).catch(() => undefined);
  return null;
}
