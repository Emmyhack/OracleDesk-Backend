/**
 * Transactional outbox for chain writes (#35), carrying the fee-bump recovery
 * that landed first (#38).
 *
 * A live write is not atomic with anything the backend does around it: the
 * process can die between signing and sending, or after the network accepted
 * the envelope. Every live write therefore persists a chain_transactions row
 * and moves it through an explicit state machine with compare-and-set
 * transitions:
 *
 *   BUILT ──→ SIGNED ──→ SUBMITTED ──→ PENDING ──→ SUCCESS | FAILED | EXPIRED
 *                 │            │            │
 *                 └────────────┴────────────┴──→ SUCCESS | FAILED | EXPIRED
 *
 * The signed envelope and hash are stored before sendTransaction, so recovery
 * can always resolve the outcome by hash (or resubmit the identical envelope,
 * which is safe: same hash, same sequence, at most one can land). PENDING
 * means the caller's inline wait expired and the recovery worker owns the row.
 *
 * Completion handlers registered per kind update domain rows idempotently from
 * the on-chain result. The inline path runs the SUCCESS handler before the
 * write resolves; FAILED/EXPIRED outcomes thrown back to a live caller are
 * marked handled (the caller's error path is the handler), so worker-driven
 * handlers only fire for rows no caller is waiting on.
 */
import { Keypair, Transaction, TransactionBuilder, rpc } from '@stellar/stellar-sdk';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { getRedis } from '../../lib/redis';
import { readClients, rpcServer } from './clients';
import { contractErrorName } from './errors';
import { FeeBumpCapExceeded, buildFeeBump, innerInclusionPerOp, planBump } from './fee-bump';

export type OutboxStatus = 'BUILT' | 'SIGNED' | 'SUBMITTED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';

export const TERMINAL_STATUSES: readonly OutboxStatus[] = ['SUCCESS', 'FAILED', 'EXPIRED'];
const IN_FLIGHT: readonly OutboxStatus[] = ['BUILT', 'SIGNED', 'SUBMITTED', 'PENDING'];

/** How long a BUILT/SIGNED row may sit before recovery treats it as crashed. */
export const SIGNED_GRACE_MS = 30_000;

export interface ChainTransactionRow {
  id: string;
  kind: string;
  refId: string | null;
  contract: string | null;
  method: string | null;
  args: unknown;
  simulated: unknown;
  source: string | null;
  sequence: string | null;
  hash: string | null;
  envelopeXdr: string | null;
  status: string;
  submitLedger: number | null;
  minTime: bigint | null;
  maxTime: bigint | null;
  ledger: number | null;
  resultXdr: string | null;
  returnValue: unknown;
  innerFee: string | null;
  resourceFee: string | null;
  feeBumpHashes: string[];
  feeBumpEnvelopes: unknown;
  landedHash: string | null;
  bumpAttempts: number;
  attempts: number;
  error: string | null;
  handledAt: Date | null;
  updatedAt?: Date;
}

export interface OutboxStore {
  create(data: Partial<ChainTransactionRow> & { kind: string }): Promise<ChainTransactionRow>;
  /** Compare-and-set transition; null when the row was already moved. */
  transition(
    id: string,
    from: OutboxStatus[],
    to: OutboxStatus,
    patch?: Partial<ChainTransactionRow>,
  ): Promise<ChainTransactionRow | null>;
  /** Non-terminal rows, oldest first; BUILT/SIGNED only when older than the grace. */
  findInFlight(now: Date, signedGraceMs: number): Promise<ChainTransactionRow[]>;
  /** Terminal rows whose completion handler has not run (crash between transition and handler). */
  findUnhandled(): Promise<ChainTransactionRow[]>;
  findByAnyHash(hashes: string[]): Promise<ChainTransactionRow | null>;
  findById(id: string): Promise<ChainTransactionRow | null>;
  markHandled(id: string): Promise<void>;
  /** Fee-bump bookkeeping (#38): CAS on bumpAttempts. */
  recordBump(row: ChainTransactionRow, outerHash: string, envelope: unknown): Promise<boolean>;
  recordError(id: string, error: string): Promise<void>;
}

// Prisma's client is generated from the schema; the cast keeps this module
// compilable before `prisma generate` has run for the new columns.
const outbox = () => (prisma as unknown as {
  chainTransaction: {
    create(args: unknown): Promise<ChainTransactionRow>;
    upsert(args: unknown): Promise<ChainTransactionRow>;
    update(args: unknown): Promise<ChainTransactionRow>;
    updateMany(args: unknown): Promise<{ count: number }>;
    findMany(args: unknown): Promise<ChainTransactionRow[]>;
    findFirst(args: unknown): Promise<ChainTransactionRow | null>;
    findUnique(args: unknown): Promise<ChainTransactionRow | null>;
  };
}).chainTransaction;

export function prismaOutboxStore(): OutboxStore {
  return {
    async create(data) {
      return outbox().create({ data });
    },
    async transition(id, from, to, patch = {}) {
      const moved = await outbox().updateMany({
        where: { id, status: { in: from } },
        data: { status: to, ...patch },
      });
      if (moved.count === 0) return null;
      return outbox().findUnique({ where: { id } });
    },
    async findInFlight(now, signedGraceMs) {
      const grace = new Date(now.getTime() - signedGraceMs);
      return outbox().findMany({
        where: {
          OR: [
            { status: { in: ['SUBMITTED', 'PENDING'] } },
            { status: { in: ['BUILT', 'SIGNED'] }, updatedAt: { lt: grace } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
    },
    async findUnhandled() {
      return outbox().findMany({
        where: { status: { in: [...TERMINAL_STATUSES] }, handledAt: null },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
    },
    async findByAnyHash(hashes) {
      if (hashes.length === 0) return null;
      return outbox().findFirst({
        where: { OR: [{ hash: { in: hashes } }, { landedHash: { in: hashes } }, { feeBumpHashes: { hasSome: hashes } }] },
      });
    },
    async findById(id) {
      return outbox().findUnique({ where: { id } });
    },
    async markHandled(id) {
      await outbox().updateMany({ where: { id, handledAt: null }, data: { handledAt: new Date() } });
    },
    async recordBump(row, outerHash, envelope) {
      const moved = await outbox().updateMany({
        where: { id: row.id, bumpAttempts: row.bumpAttempts, status: { in: ['SUBMITTED', 'PENDING'] } },
        data: {
          bumpAttempts: row.bumpAttempts + 1,
          feeBumpHashes: { push: outerHash },
          feeBumpEnvelopes: { push: envelope },
        },
      });
      return moved.count > 0;
    },
    async recordError(id, error) {
      await outbox().updateMany({ where: { id }, data: { error } });
    },
  };
}

// ─── Completion handlers ─────────────────────────────────────────────────────

export interface CompletionOutcome {
  status: 'SUCCESS' | 'FAILED' | 'EXPIRED';
  /** Native return value for SUCCESS (e.g. the on-chain market id or shares). */
  value?: unknown;
  txHash?: string | null;
  error?: string | null;
}

export type CompletionHandler = (row: ChainTransactionRow, outcome: CompletionOutcome) => Promise<void>;

const handlers = new Map<string, CompletionHandler>();

/** Kinds that must have a handler; resolving one without is an error, never a skip. */
const DOMAIN_KINDS = new Set(['market.create', 'trade.buy', 'trade.sell', 'trace.publish']);

/** Registers the idempotent completion handler for one kind (at module load). */
export function registerHandler(kind: string, handler: CompletionHandler): void {
  handlers.set(kind, handler);
}

/**
 * Runs the kind's handler, then marks the row handled. The handler runs before
 * the mark on purpose: a crash in between re-runs the handler, which must be
 * idempotent; the reverse order would lose the run entirely.
 */
export async function runCompletionHandler(
  row: ChainTransactionRow,
  outcome: CompletionOutcome,
  store: OutboxStore = prismaOutboxStore(),
): Promise<void> {
  if (row.handledAt) return;
  const handler = handlers.get(row.kind);
  if (!handler && DOMAIN_KINDS.has(row.kind)) {
    // The owning module has not loaded (or failed to): leaving the row
    // unhandled keeps it visible to the next recovery pass instead of
    // silently dropping the domain update.
    throw new Error(`no completion handler registered for ${row.kind}`);
  }
  if (handler) await handler(row, outcome);
  await store.markHandled(row.id);
}

/** Visible for tests: forget registered handlers. */
export function clearHandlersForTest(): void {
  handlers.clear();
}

// ─── #38 compatibility layer ─────────────────────────────────────────────────

/** Persists a signed inner envelope before it is sent. Idempotent on the hash. */
export async function recordTransaction(input: {
  kind: string;
  refId?: string | null;
  hash: string;
  envelopeXdr: string;
  maxTime?: bigint | null;
  innerFee?: bigint | null;
  resourceFee?: bigint | null;
}): Promise<void> {
  await outbox().upsert({
    where: { hash: input.hash },
    update: {},
    create: {
      kind: input.kind,
      refId: input.refId ?? null,
      hash: input.hash,
      envelopeXdr: input.envelopeXdr,
      maxTime: input.maxTime ?? null,
      innerFee: input.innerFee?.toString() ?? null,
      resourceFee: input.resourceFee?.toString() ?? null,
      status: 'SIGNED',
    },
  });
}

export async function markSubmitted(hash: string, submitLedger: number): Promise<void> {
  await outbox().updateMany({ where: { hash, status: { in: ['SIGNED'] } }, data: { status: 'SUBMITTED', submitLedger } });
}

export async function findRowByAnyHash(hashes: string[]): Promise<ChainTransactionRow | null> {
  return prismaOutboxStore().findByAnyHash(hashes);
}

/** The inner (identity) hash for any outer/inner hash, or null if unknown. */
export async function innerHashForTx(txHash: string): Promise<string | null> {
  const row = await findRowByAnyHash([txHash]);
  return row ? row.hash : null;
}

/**
 * After a bump lands, the domain row must store the hash that actually appears
 * on chain (outer) plus the inner hash for reference (#38).
 */
async function applyLandedHash(row: ChainTransactionRow, landedHash: string): Promise<void> {
  const db = prisma as unknown as {
    trade: { updateMany(args: unknown): Promise<unknown> };
    market: { updateMany(args: unknown): Promise<unknown> };
    reasoningTrace: { updateMany(args: unknown): Promise<unknown> };
  };
  try {
    if ((row.kind === 'trade' || row.kind === 'trade.buy') && row.refId) {
      await db.trade.updateMany({ where: { id: row.refId }, data: { txHash: landedHash, innerTxHash: row.hash } });
    } else if ((row.kind === 'market' || row.kind === 'market.create') && row.refId) {
      await db.market.updateMany({ where: { id: row.refId }, data: { creationTxHash: landedHash, creationInnerTxHash: row.hash } });
    } else if ((row.kind === 'trace' || row.kind === 'trace.publish') && row.refId) {
      await db.reasoningTrace.updateMany({ where: { id: row.refId }, data: { publishTxHash: landedHash, publishInnerTxHash: row.hash } });
    }
  } catch (err) {
    logger.warn({ err, hash: row.hash, landedHash }, 'outbox: could not record the landed hash on the domain row');
  }
}

export interface BumpGate {
  status: string;
  submitLedger: number | null;
  maxTime: bigint | null;
  bumpAttempts: number;
}

/**
 * Whether a row may be fee-bumped now: pending past the threshold, under the
 * attempt cap, and not within one ledger of its inner maxTime (a bump cannot
 * extend timebounds).
 */
export function shouldBump(row: BumpGate, latestLedger: number, nowSecs: number, opts: { afterLedgers: number; maxAttempts: number }): boolean {
  if (row.status !== 'PENDING' && row.status !== 'SUBMITTED') return false;
  if (row.submitLedger == null) return false;
  if (row.bumpAttempts >= opts.maxAttempts) return false;
  if (latestLedger - row.submitLedger < opts.afterLedgers) return false;
  if (row.maxTime != null && BigInt(nowSecs) >= row.maxTime - 5n) return false;
  return true;
}

// ─── Recovery ────────────────────────────────────────────────────────────────

export type RecoveryRpc = Pick<rpc.Server, 'getLatestLedger' | 'getTransaction' | 'sendTransaction'>;

export interface RecoverDeps {
  server?: RecoveryRpc;
  store?: OutboxStore;
  now?: () => number;
  ledgerOverride?: number;
  feePayer?: Keypair;
  signedGraceMs?: number;
}

export interface RecoveryStats {
  resolved: number;
  resubmitted: number;
  expired: number;
  handled: number;
  bumped: number;
}

function feePayerKeypair(deps: RecoverDeps): Keypair {
  if (deps.feePayer) return deps.feePayer;
  return Keypair.fromSecret(config.FEE_PAYER_SECRET);
}

type BindingContract = 'marketCore' | 'treasury' | 'resolver' | 'reasoningRegistry';

/** JSON-safe view, mirrored from chain.service to avoid an import cycle. */
function printableValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map(printableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, printableValue(v)]));
  }
  return value;
}

/**
 * Native return value of a landed transaction, decoded with the binding's
 * spec (`funcResToNative`), unwrapping contract `Result`s. Null when the row
 * does not name a known contract/method or the value cannot be decoded.
 */
export function parseReturnValue(row: Pick<ChainTransactionRow, 'contract' | 'method'>, returnValue: unknown): unknown {
  if (!row.contract || !row.method || returnValue == null) return null;
  const clients: Record<string, () => { spec: { funcResToNative(method: string, val: unknown): unknown } }> = readClients;
  const client = clients[row.contract as BindingContract];
  if (!client) return null;
  try {
    const native = client().spec.funcResToNative(row.method, returnValue);
    if (native && typeof native === 'object' && 'isOk' in native && typeof (native as { isOk: unknown }).isOk === 'function') {
      const result = native as { isOk(): boolean; unwrap(): unknown };
      return result.isOk() ? result.unwrap() : null;
    }
    return native;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, method: row.method }, 'outbox: return value did not decode');
    return null;
  }
}

/** Expiry by timebounds: NOT_FOUND past maxTime (plus skew) can never land. */
function isPastMaxTime(row: ChainTransactionRow, nowSecs: number, skewSecs = 60): boolean {
  return row.maxTime != null && BigInt(nowSecs) > row.maxTime + BigInt(skewSecs);
}

/** Resolves one row against chain state. Exposed for the indexer hook. */
export async function recoverRow(
  row: ChainTransactionRow,
  deps: RecoverDeps = {},
  stats: RecoveryStats = { resolved: 0, resubmitted: 0, expired: 0, handled: 0, bumped: 0 },
): Promise<RecoveryStats> {
  const server = deps.server ?? rpcServer;
  const store = deps.store ?? prismaOutboxStore();
  const nowSecs = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

  // Crash between create and sign: nothing was signed, nothing can land.
  if (row.status === 'BUILT') {
    const moved = await store.transition(row.id, ['BUILT'], 'FAILED', { error: 'abandoned before signing' });
    if (moved) {
      await runCompletionHandler(moved, { status: 'FAILED', error: moved.error }, store);
      stats.resolved++;
      stats.handled++;
    }
    return stats;
  }

  if (!row.hash) return stats;

  const hashes = [row.hash, ...(row.feeBumpHashes ?? [])];
  let landed: { hash: string; status: 'SUCCESS' | 'FAILED'; resp: rpc.Api.GetTransactionResponse } | null = null;
  for (const hash of hashes) {
    const resp = await server.getTransaction(hash);
    if (resp.status === 'SUCCESS' || resp.status === 'FAILED') {
      landed = { hash, status: resp.status, resp };
      break;
    }
  }

  if (landed) {
    const anyResp = landed.resp as { ledger?: number; returnValue?: unknown; resultXdr?: { toXDR(enc: string): string } };
    if (landed.status === 'SUCCESS') {
      const value = parseReturnValue(row, anyResp.returnValue);
      const moved = await store.transition(row.id, [...IN_FLIGHT], 'SUCCESS', {
        landedHash: landed.hash,
        ledger: anyResp.ledger ?? null,
        returnValue: printableValue(value) ?? undefined,
      });
      if (moved) {
        await applyLandedHash(moved, landed.hash);
        await runCompletionHandler(moved, { status: 'SUCCESS', value, txHash: landed.hash }, store);
        stats.resolved++;
        stats.handled++;
      }
    } else {
      const error = contractErrorName((row.contract ?? 'treasury') as BindingContract, landed.resp) ?? 'transaction failed on-chain';
      const moved = await store.transition(row.id, [...IN_FLIGHT], 'FAILED', { landedHash: landed.hash, error });
      if (moved) {
        await runCompletionHandler(moved, { status: 'FAILED', error, txHash: landed.hash }, store);
        stats.resolved++;
        stats.handled++;
      }
    }
    return stats;
  }

  // NOT_FOUND everywhere. Past the timebounds nothing can land any more.
  if (isPastMaxTime(row, nowSecs)) {
    const moved = await store.transition(row.id, [...IN_FLIGHT], 'EXPIRED', { error: 'expired by timebounds' });
    if (moved) {
      await runCompletionHandler(moved, { status: 'EXPIRED', txHash: row.hash }, store);
      stats.expired++;
      stats.handled++;
    }
    return stats;
  }

  // Crash between sign and send: the stored envelope resubmits byte-for-byte,
  // which is safe (same hash, same sequence; at most one copy can execute).
  if (row.status === 'SIGNED' && row.envelopeXdr) {
    try {
      const signed = TransactionBuilder.fromXDR(row.envelopeXdr, config.STELLAR_NETWORK_PASSPHRASE) as Transaction;
      const resp = await server.sendTransaction(signed);
      if (resp.status === 'PENDING' || resp.status === 'DUPLICATE') {
        await store.transition(row.id, ['SIGNED'], 'SUBMITTED', { submitLedger: resp.latestLedger ?? null });
        stats.resubmitted++;
      } else if (resp.status === 'ERROR') {
        // tx_bad_seq (or any decoded rejection) means this envelope can never land.
        const moved = await store.transition(row.id, ['SIGNED'], 'FAILED', { error: 'rejected on resubmit' });
        if (moved) {
          await runCompletionHandler(moved, { status: 'FAILED', error: moved.error }, store);
          stats.handled++;
        }
      }
      // TRY_AGAIN_LATER: leave SIGNED; the next pass retries.
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, hash: row.hash }, 'outbox: resubmit failed; will retry');
    }
    return stats;
  }

  // Submitted but not yet visible: fee-bump when stuck past the threshold (#38).
  if (!config.FEE_BUMP_ENABLED) return stats;
  const latestLedger = deps.ledgerOverride ?? (await server.getLatestLedger()).sequence;
  if (!shouldBump(row, latestLedger, nowSecs, {
    afterLedgers: config.FEE_BUMP_AFTER_LEDGERS,
    maxAttempts: config.FEE_BUMP_MAX_ATTEMPTS,
  })) {
    return stats;
  }
  if (await bumpRow(row, server, feePayerKeypair(deps), store)) stats.bumped++;
  return stats;
}

/**
 * One recovery pass: resolve every non-terminal row, run completion handlers
 * for terminal rows a crash left unhandled, and fee-bump stuck submissions.
 */
export async function recoverInFlight(deps: RecoverDeps = {}): Promise<RecoveryStats> {
  const store = deps.store ?? prismaOutboxStore();
  const stats: RecoveryStats = { resolved: 0, resubmitted: 0, expired: 0, handled: 0, bumped: 0 };
  const now = deps.now ? new Date(deps.now() * 1000) : new Date();

  // Crash between a terminal transition and its handler: run the handler now.
  for (const row of await store.findUnhandled()) {
    try {
      await runCompletionHandler(
        row,
        {
          status: row.status as 'SUCCESS' | 'FAILED' | 'EXPIRED',
          value: row.status === 'SUCCESS' ? row.returnValue : undefined,
          txHash: row.landedHash ?? row.hash,
          error: row.error,
        },
        store,
      );
      stats.handled++;
    } catch (err) {
      logger.error({ err, outboxId: row.id, kind: row.kind }, 'outbox: completion handler failed; will retry');
    }
  }

  for (const row of await store.findInFlight(now, deps.signedGraceMs ?? SIGNED_GRACE_MS)) {
    try {
      await recoverRow(row, { ...deps, store }, stats);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, outboxId: row.id }, 'outbox: recovery of one row failed; next pass retries');
    }
  }
  return stats;
}

/**
 * Indexer hook (#35): an indexed event's txHash proves the transaction landed,
 * so a matching non-terminal row resolves without waiting for the poll.
 */
export async function recoverByTxHash(txHash: string, deps: RecoverDeps = {}): Promise<void> {
  const store = deps.store ?? prismaOutboxStore();
  const row = await store.findByAnyHash([txHash]);
  if (!row || TERMINAL_STATUSES.includes(row.status as OutboxStatus)) return;
  await recoverRow(row, { ...deps, store });
}

async function bumpRow(
  row: ChainTransactionRow,
  server: Pick<rpc.Server, 'getTransaction' | 'sendTransaction'>,
  feePayer: Keypair,
  store: OutboxStore,
): Promise<boolean> {
  let inner: Transaction;
  try {
    inner = TransactionBuilder.fromXDR(row.envelopeXdr!, config.STELLAR_NETWORK_PASSPHRASE) as Transaction;
  } catch (err) {
    logger.error({ err, hash: row.hash }, 'fee bump: stored envelope could not be parsed');
    return false;
  }

  const prev = row.feeBumpEnvelopes && Array.isArray(row.feeBumpEnvelopes) && row.feeBumpEnvelopes.length > 0
    ? BigInt((row.feeBumpEnvelopes as Array<{ inclusionPerOp?: string }>)[row.feeBumpEnvelopes.length - 1].inclusionPerOp ?? innerInclusionPerOp(inner).toString())
    : innerInclusionPerOp(inner);

  let outer;
  try {
    const plan = planBump(inner, prev, {
      multiplier: config.FEE_BUMP_MULTIPLIER,
      maxStroops: BigInt(config.FEE_BUMP_MAX_STROOPS),
    });
    outer = buildFeeBump(inner, plan, feePayer.publicKey(), config.STELLAR_NETWORK_PASSPHRASE);
    outer.sign(feePayer);
  } catch (err) {
    if (err instanceof FeeBumpCapExceeded) {
      logger.warn({ hash: row.hash, outerFee: err.outerFee.toString() }, 'fee bump: cap exceeded; leaving row pending');
      await store.recordError(row.id, 'FEE_BUMP_CAP_EXCEEDED');
      return false;
    }
    logger.error({ err, hash: row.hash }, 'fee bump: could not build a bump');
    return false;
  }

  const outerHash = outer.hash().toString('hex');
  const envelope = { hash: outerHash, fee: String(outer.fee), xdr: outer.toEnvelope().toXDR('base64'), at: new Date().toISOString() };

  // Compare-and-set on bumpAttempts so two workers produce one bump per attempt.
  if (!(await store.recordBump(row, outerHash, envelope))) return false;

  // Persisted before sending, as for every submission.
  try {
    const resp = await server.sendTransaction(outer);
    if (resp.status === 'ERROR') {
      // Expected after the inner already landed; poll before deciding.
      const recheck = await server.getTransaction(row.hash!);
      if (recheck.status === 'SUCCESS' || recheck.status === 'FAILED') {
        const moved = await store.transition(row.id, [...IN_FLIGHT], recheck.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED', {
          landedHash: row.hash,
        });
        if (moved) {
          await runCompletionHandler(
            moved,
            {
              status: recheck.status,
              value: recheck.status === 'SUCCESS' ? parseReturnValue(row, (recheck as { returnValue?: unknown }).returnValue) : undefined,
              txHash: row.hash,
            },
            store,
          );
        }
      }
    }
  } catch (err) {
    logger.warn({ err, hash: row.hash, outerHash }, 'fee bump: submit errored; will re-poll');
  }
  logger.info({ hash: row.hash, outerHash, fee: String(outer.fee) }, 'fee bump submitted');
  return true;
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const LOCK_KEY = 'outbox:recover';

/** Runs fn under a best-effort Redis lock so one instance recovers at a time. */
async function withRecoveryLock(fn: () => Promise<void>): Promise<void> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let locked = false;
  try {
    const res = await getRedis().set(LOCK_KEY, token, 'PX', Math.max(config.OUTBOX_POLL_MS * 2, 30_000), 'NX');
    locked = res === 'OK';
  } catch (err) {
    // Redis down: recover anyway. Transitions are compare-and-set, so a second
    // concurrent recoverer cannot double-apply; the lock only avoids wasted work.
    logger.warn({ err: err instanceof Error ? err.message : err }, 'outbox: recovery lock unavailable; proceeding');
    locked = true;
  }
  if (!locked) return;
  try {
    await fn();
  } finally {
    try {
      const redis = getRedis();
      const current = await redis.get(LOCK_KEY);
      if (current === token) await redis.del(LOCK_KEY);
    } catch {
      /* lock expires on its own */
    }
  }
}

/**
 * The modules whose completion handlers must be registered before recovery
 * touches a row. Imported lazily: they import chain.service, which imports
 * this module, so a static import would be a cycle.
 */
async function loadCompletionHandlers(): Promise<void> {
  await Promise.all([
    import('../market-chain.service'),
    import('../trade.service'),
    import('../exit.service'),
    import('../trace-publish.service'),
  ]);
}

/**
 * Starts the recovery worker: one pass immediately (resolving whatever a
 * previous process left in flight), then every OUTBOX_POLL_MS. Returns a stop
 * function for shutdown; in-flight rows are picked up on the next boot.
 */
export function startOutboxWorker(deps: RecoverDeps = {}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const handlersReady = loadCompletionHandlers().catch((err) => {
    logger.error({ err }, 'outbox: completion handlers failed to load; recovery still resolves rows');
  });
  const tick = async () => {
    await handlersReady;
    try {
      await withRecoveryLock(async () => {
        const stats = await recoverInFlight(deps);
        if (stats.resolved || stats.resubmitted || stats.expired || stats.handled || stats.bumped) {
          logger.info({ ...stats }, 'outbox: recovery pass');
        }
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'outbox: recovery pass failed; will retry');
    }
    if (!stopped) timer = setTimeout(tick, config.OUTBOX_POLL_MS);
  };
  void tick();
  logger.info({ pollMs: config.OUTBOX_POLL_MS }, 'outbox recovery worker started');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
