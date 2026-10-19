/**
 * Trace publication worker (#131).
 *
 * Drives every `trace_publications` row through
 *   AWAITING_PIN → AWAITING_MARKET → READY → SUBMITTED → CONFIRMED  (or FAILED)
 *
 * - AWAITING_PIN:    pin the stored payload; the pinned bytes define traceHash.
 * - AWAITING_MARKET: wait until the market has an on-chain id (voided → FAILED).
 * - READY:           make sure the hash isn't already on-chain (trace row link,
 *                    then the registry's per-market index), then publish once.
 * - SUBMITTED:       confirmation comes from the indexer's TracePublished event
 *                    (indexer.service.ts); after TRACE_CONFIRM_TIMEOUT_MS the
 *                    chain is re-checked before any retry, so a hash is never
 *                    published twice.
 *
 * Chain calls always run outside any database transaction: rows are claimed
 * with FOR UPDATE SKIP LOCKED, leased, committed, then worked on.
 * Dry-run never confirms a row or sets `verified`.
 */
import { TracePublicationStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { AppError } from '../middlewares/error.middleware';
import { pinJson } from '../services/ipfs.service';
import { publishTrace, ExpiredError, ChainPendingError } from '../services/chain.service';
import { ChainError } from '../services/stellar/errors';
import { AgentPausedError } from '../services/agent-controls.service';
import { agentSigner } from '../services/stellar/clients';
import { defaultRegistryReader, type RegistryReader } from '../services/trace-audit.service';

const S = TracePublicationStatus;

/** Contract errors that retrying can't fix. */
const PERMANENT_CONTRACT_ERRORS = new Set(['AgentNotRegistered', 'EmptyAction', 'EmptyCid']);
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const MARKET_WAIT_MS = 5 * 60_000;
/** How long a trace waits when its agent is paused (#79). */
const PAUSED_RECHECK_MS = 5 * 60_000;
const DRY_RUN_RECHECK_MS = 6 * 60 * 60_000;
const CLAIM_LEASE_MS = 2 * 60_000;
/** How many of a market's newest registry traces the duplicate check reads. */
const DUPLICATE_SCAN_LIMIT = 10;
/** Max state transitions handled for one row in one pass. */
const MAX_STEPS = 6;

export interface TracePublisher {
  agent(): string;
  publish(
    args: {
      market_id: bigint;
      action: string;
      trace_hash: Buffer;
      ipfs_cid: string;
    },
    ref?: { kind: string; refId: string },
  ): Promise<{ mode: 'dry-run' | 'live'; value: bigint; txHash: string | null }>;
}

export const defaultPublisher: TracePublisher = {
  agent: () => agentSigner().publicKey as string,
  publish: (args, ref) => publishTrace({ agent: agentSigner().publicKey as string, ...args }, undefined, undefined, ref),
};

export interface PublicationRow {
  id: string;
  traceId: string;
  action: string;
  payload: unknown;
  status: TracePublicationStatus;
  attempts: number;
  submittedTraceId: bigint | null;
}

export interface WorkerDeps {
  prisma?: any;
  publisher?: TracePublisher;
  reader?: RegistryReader;
  pin?: (payload: Record<string, unknown>, name: string) => Promise<{ cid: string; hash: string }>;
  dryRun?: boolean;
  maxAttempts?: number;
  confirmTimeoutMs?: number;
  claim?: (batch: number, now: Date) => Promise<PublicationRow[]>;
}

interface Ctx {
  prisma: any;
  publisher: TracePublisher;
  reader: RegistryReader;
  pin: NonNullable<WorkerDeps['pin']>;
  dryRun: boolean;
  maxAttempts: number;
  confirmTimeoutMs: number;
  now: Date;
}

function ctxFrom(deps: WorkerDeps, now: Date): Ctx {
  return {
    prisma: deps.prisma ?? defaultPrisma,
    publisher: deps.publisher ?? defaultPublisher,
    reader: deps.reader ?? defaultRegistryReader,
    pin: deps.pin ?? ((payload, name) => pinJson(payload, name)),
    dryRun: deps.dryRun ?? config.CHAIN_EXECUTION_MODE === 'dry-run',
    maxAttempts: deps.maxAttempts ?? config.TRACE_PUBLISH_MAX_ATTEMPTS,
    confirmTimeoutMs: deps.confirmTimeoutMs ?? config.TRACE_CONFIRM_TIMEOUT_MS,
    now,
  };
}

const after = (now: Date, ms: number) => new Date(now.getTime() + ms);

export const backoffMs = (attempts: number) =>
  Math.min(2 ** attempts * BASE_BACKOFF_MS, MAX_BACKOFF_MS);

const hexOf = (h: Buffer | Uint8Array | string) =>
  (typeof h === 'string' ? h : Buffer.from(h).toString('hex')).toLowerCase();

/**
 * Claims due rows with FOR UPDATE SKIP LOCKED and leases them (pushes
 * nextAttemptAt out) inside one short transaction, so concurrent workers never
 * pick the same row. Chain work happens after this commits.
 */
export async function claimDuePublications(batch: number, now: Date, prisma: any = defaultPrisma): Promise<PublicationRow[]> {
  return prisma.$transaction(async (tx: any) => {
    const rows: PublicationRow[] = await tx.$queryRaw`
      SELECT "id", "traceId", "action", "payload", "status", "attempts", "submittedTraceId"
      FROM "trace_publications"
      WHERE "status" IN ('AWAITING_PIN', 'AWAITING_MARKET', 'READY', 'SUBMITTED')
        AND "nextAttemptAt" <= ${now}
      ORDER BY "nextAttemptAt"
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length > 0) {
      await tx.tracePublication.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { nextAttemptAt: after(now, CLAIM_LEASE_MS) },
      });
    }
    return rows;
  });
}

/** Processes due rows. Safe to run from several processes at once. */
export async function processTracePublications(
  opts: { batch?: number; now?: Date } & WorkerDeps = {},
): Promise<{ processed: number; byStatus: Record<string, number> }> {
  const now = opts.now ?? new Date();
  const ctx = ctxFrom(opts, now);
  const rows = await (opts.claim ?? ((b, n) => claimDuePublications(b, n, ctx.prisma)))(opts.batch ?? 20, now);
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    const status = await processPublication(row, ctx);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  if (rows.length > 0) logger.info({ processed: rows.length, byStatus }, 'Trace publication worker pass complete');
  return { processed: rows.length, byStatus };
}

/** Runs one row's state machine until it parks, finishes, or fails. */
export async function processPublication(row: PublicationRow, ctxOrDeps: Ctx | WorkerDeps): Promise<TracePublicationStatus> {
  const ctx = 'now' in ctxOrDeps && ctxOrDeps.now instanceof Date
    ? (ctxOrDeps as Ctx)
    : ctxFrom(ctxOrDeps as WorkerDeps, new Date());
  let current: PublicationRow = { ...row };
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const next = await advance(current, ctx);
      if (!next) return current.status;
      current = { ...current, ...next.row };
      if (next.park) return current.status;
    }
    return current.status;
  } catch (err) {
    return handleError(current, err, ctx);
  }
}

type Advance = { row: Partial<PublicationRow>; park: boolean } | null;

async function update(ctx: Ctx, id: string, data: Record<string, unknown>) {
  await ctx.prisma.tracePublication.update({ where: { id }, data });
}

async function loadTrace(ctx: Ctx, traceId: string) {
  return ctx.prisma.reasoningTrace.findUnique({
    where: { id: traceId },
    select: {
      id: true,
      traceHash: true,
      ipfsCid: true,
      onChainTraceId: true,
      market: { select: { onChainMarketId: true, status: true } },
    },
  });
}

async function confirm(ctx: Ctx, row: PublicationRow, onChainTraceId: bigint | null, alreadyLinked: boolean): Promise<Advance> {
  if (!alreadyLinked && onChainTraceId !== null) {
    await ctx.prisma.reasoningTrace.update({
      where: { id: row.traceId },
      data: { onChainTraceId, verified: true },
    });
  }
  await update(ctx, row.id, { status: S.CONFIRMED, confirmedAt: ctx.now, lastError: null });
  return { row: { status: S.CONFIRMED }, park: true };
}

/** Newest-first scan of the market's registry index for this agent + hash. */
async function findOnChainDuplicate(ctx: Ctx, marketId: bigint, traceHash: string): Promise<bigint | null> {
  const agent = ctx.publisher.agent().toUpperCase();
  const count = await ctx.reader.marketTraceCount(marketId);
  for (let i = count - 1n, seen = 0; i >= 0n && seen < DUPLICATE_SCAN_LIMIT; i--, seen++) {
    const id = await ctx.reader.marketTraceAt(marketId, i);
    const onChain = await ctx.reader.getOnChainTraceOrNull(id);
    if (!onChain) continue;
    if (String(onChain.agent).toUpperCase() === agent && hexOf(onChain.trace_hash) === traceHash.toLowerCase()) {
      return id;
    }
  }
  return null;
}

async function advance(row: PublicationRow, ctx: Ctx): Promise<Advance> {
  switch (row.status) {
    case S.AWAITING_PIN: {
      if (row.payload == null) {
        const trace = await loadTrace(ctx, row.traceId);
        if (trace?.traceHash && trace.ipfsCid) {
          await update(ctx, row.id, { status: S.AWAITING_MARKET });
          return { row: { status: S.AWAITING_MARKET }, park: false };
        }
        await update(ctx, row.id, { status: S.FAILED, lastError: 'NO_PAYLOAD' });
        return { row: { status: S.FAILED }, park: true };
      }
      try {
        const pinned = await ctx.pin(row.payload as Record<string, unknown>, `oracledesk-trace-${row.traceId}`);
        await ctx.prisma.reasoningTrace.update({
          where: { id: row.traceId },
          data: { ipfsCid: pinned.cid, traceHash: pinned.hash },
        });
      } catch (err) {
        if (err instanceof AppError && err.code === 'IPFS_NOT_CONFIGURED') {
          // Not a failure of this row: keep the payload and check back later.
          await update(ctx, row.id, { lastError: 'IPFS_NOT_CONFIGURED', nextAttemptAt: after(ctx.now, MAX_BACKOFF_MS) });
          return { row: {}, park: true };
        }
        throw err;
      }
      await update(ctx, row.id, { status: S.AWAITING_MARKET, lastError: null });
      return { row: { status: S.AWAITING_MARKET }, park: false };
    }

    case S.AWAITING_MARKET: {
      const trace = await loadTrace(ctx, row.traceId);
      if (!trace) {
        await update(ctx, row.id, { status: S.FAILED, lastError: 'TRACE_NOT_FOUND' });
        return { row: { status: S.FAILED }, park: true };
      }
      if (trace.market?.status === 'CANCELLED') {
        await update(ctx, row.id, { status: S.FAILED, lastError: 'MARKET_CANCELLED' });
        return { row: { status: S.FAILED }, park: true };
      }
      if (trace.market?.onChainMarketId == null) {
        // Waiting isn't a failed attempt.
        await update(ctx, row.id, { nextAttemptAt: after(ctx.now, MARKET_WAIT_MS) });
        return { row: {}, park: true };
      }
      await update(ctx, row.id, { status: S.READY });
      return { row: { status: S.READY }, park: false };
    }

    case S.READY: {
      const trace = await loadTrace(ctx, row.traceId);
      if (!trace?.traceHash || !trace.ipfsCid || trace.market?.onChainMarketId == null) {
        await update(ctx, row.id, { status: S.AWAITING_MARKET });
        return { row: { status: S.AWAITING_MARKET }, park: false };
      }
      if (!ctx.dryRun) {
        // Never publish a hash twice: trust the indexer link first, then chain state.
        if (trace.onChainTraceId != null) return confirm(ctx, row, trace.onChainTraceId, true);
        const dup = await findOnChainDuplicate(ctx, trace.market.onChainMarketId, trace.traceHash);
        if (dup !== null) return confirm(ctx, row, dup, false);
      }
      const result = await ctx.publisher.publish(
        {
          market_id: trace.market.onChainMarketId,
          action: row.action,
          trace_hash: Buffer.from(trace.traceHash, 'hex'),
          ipfs_cid: trace.ipfsCid,
        },
        // #35: the trace.publish completion handler links onChainTraceId even
        // when this worker dies before its own confirm step runs.
        { kind: 'trace.publish', refId: row.traceId },
      );
      if (result.mode === 'dry-run') {
        logger.info({ traceId: row.traceId, simulatedTraceId: String(result.value) }, 'dry-run: trace publish simulated, row stays READY');
        await update(ctx, row.id, { nextAttemptAt: after(ctx.now, DRY_RUN_RECHECK_MS) });
        return { row: {}, park: true };
      }
      await update(ctx, row.id, {
        status: S.SUBMITTED,
        submittedTxHash: result.txHash,
        submittedTraceId: result.value,
        nextAttemptAt: after(ctx.now, ctx.confirmTimeoutMs),
        lastError: null,
      });
      return { row: { status: S.SUBMITTED, submittedTraceId: result.value }, park: true };
    }

    case S.SUBMITTED: {
      // The indexer didn't confirm within TRACE_CONFIRM_TIMEOUT_MS. Check chain
      // state before trying again so a landed transaction isn't repeated.
      const trace = await loadTrace(ctx, row.traceId);
      if (!ctx.dryRun && trace?.onChainTraceId != null) return confirm(ctx, row, trace.onChainTraceId, true);
      if (!ctx.dryRun && trace?.traceHash && row.submittedTraceId != null) {
        const onChain = await ctx.reader.getOnChainTraceOrNull(row.submittedTraceId);
        if (onChain && hexOf(onChain.trace_hash) === trace.traceHash.toLowerCase()) {
          return confirm(ctx, row, row.submittedTraceId, false);
        }
      }
      const attempts = row.attempts + 1;
      if (attempts >= ctx.maxAttempts) {
        await update(ctx, row.id, { status: S.FAILED, attempts, lastError: 'NOT_CONFIRMED' });
        return { row: { status: S.FAILED, attempts }, park: true };
      }
      await update(ctx, row.id, { status: S.READY, attempts, nextAttemptAt: after(ctx.now, backoffMs(attempts)) });
      return { row: { status: S.READY, attempts }, park: true };
    }

    default:
      return null;
  }
}

async function handleError(row: PublicationRow, err: unknown, ctx: Ctx): Promise<TracePublicationStatus> {
  // A paused agent publishes later; waiting is not a failed attempt.
  if (err instanceof AgentPausedError) {
    await update(ctx, row.id, { nextAttemptAt: after(ctx.now, PAUSED_RECHECK_MS) });
    logger.info({ traceId: row.traceId }, 'Trace publication deferred: agent paused');
    return row.status;
  }
  // Submitted but unconfirmed within the inline wait (#35): the outbox worker
  // and the trace.publish handler confirm it; this row re-checks chain state
  // from SUBMITTED exactly as it does after an indexer-confirmation timeout.
  if (err instanceof ChainPendingError) {
    await update(ctx, row.id, {
      status: S.SUBMITTED,
      submittedTxHash: err.txHash ?? null,
      nextAttemptAt: after(ctx.now, ctx.confirmTimeoutMs),
      lastError: null,
    });
    logger.info({ traceId: row.traceId, txHash: err.txHash }, 'Trace publication submitted; awaiting outbox confirmation');
    return S.SUBMITTED;
  }
  if (err instanceof ExpiredError) {
    const attempts = row.attempts + 1;
    await update(ctx, row.id, {
      status: S.READY,
      attempts,
      submittedTxHash: err.txHash ?? null,
      lastError: 'CHAIN_TX_EXPIRED',
      nextAttemptAt: after(ctx.now, backoffMs(attempts)),
    });
    logger.info({ traceId: row.traceId, attempts, prevTxHash: err.txHash }, 'Trace publication expired; will rebuild and resubmit');
    return S.READY;
  }
  const contractError = err instanceof ChainError ? err.contractError : null;
  const message = contractError ?? (err instanceof Error ? err.message : String(err));
  if (contractError && PERMANENT_CONTRACT_ERRORS.has(contractError)) {
    await update(ctx, row.id, { status: S.FAILED, lastError: contractError });
    logger.error({ traceId: row.traceId, contractError }, 'Trace publication failed permanently');
    return S.FAILED;
  }
  const attempts = row.attempts + 1;
  if (attempts >= ctx.maxAttempts) {
    await update(ctx, row.id, { status: S.FAILED, attempts, lastError: message });
    logger.error({ traceId: row.traceId, attempts, err }, 'Trace publication gave up after max attempts');
    return S.FAILED;
  }
  await update(ctx, row.id, { attempts, lastError: message, nextAttemptAt: after(ctx.now, backoffMs(attempts)) });
  logger.warn({ traceId: row.traceId, attempts, err }, 'Trace publication attempt failed; will retry');
  return row.status;
}
