/**
 * Per-source-account serialisation for live writes (#36).
 *
 * Two builds that read the same RPC account sequence produce two transactions
 * with the same sequence number and only one can land. `withSourceAccount`
 * takes a fair, fenced, per-account lock in Redis, allocates the next sequence
 * number from a cached counter and gives the caller an `Account` carrying it.
 * The cached counter is only advanced when the network accepted a submission.
 *
 * The binding clients build through `rpc.Server.getAccount` themselves, so the
 * allocated sequence cannot be handed to them directly; `rebuildWithSequence`
 * (used by chain.service) rewrites the already-simulated transaction with the
 * allocated number without touching src/generated. See docs/architecture.md.
 */
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { Account, rpc, TransactionBuilder } from '@stellar/stellar-sdk';
import { config } from '../../config';
import {
  acquireLock,
  advanceSequence as advanceSequenceInRedis,
  getRedis,
  releaseLock,
  renewLock,
} from '../../lib/redis';
import { logger } from '../../lib/logger';
import { ChainError } from './errors';
import { rpcServer } from './clients';

/** Thrown inside the critical section when this holder lost its lock (#36). */
export class SequenceLockLost extends Error {
  constructor(account: string) {
    super(`Lost the source-account lock for ${account} before submitting`);
    this.name = 'SequenceLockLost';
  }
}

/** Thrown when withSourceAccount is called recursively for the same account (#36). */
export class SequenceReentrancy extends Error {
  constructor(account: string) {
    super(`withSourceAccount(${account}) was called while already holding this account's lock`);
    this.name = 'SequenceReentrancy';
  }
}

export interface SequenceContext {
  account: Account;
  fence: number;
  renew(): Promise<void>;
  /** Throws SequenceLockLost if the lock expired or was taken over. */
  assertHeld(): void;
  /** Advance the cached sequence on an accepted submission. */
  advanceSequence(): Promise<void>;
  /** Re-read the sequence from RPC after a bad-sequence rejection. */
  resync(): Promise<void>;
}

export interface SequenceDeps {
  rpc: Pick<rpc.Server, 'getAccount'>;
  redis?: ReturnType<typeof getRedis>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const heldAccounts = new AsyncLocalStorage<Set<string>>();

/** Short, stable network key so cached sequence keys are comparable across hosts. */
export function networkKey(): string {
  return crypto.createHash('sha256').update(config.STELLAR_NETWORK_PASSPHRASE).digest('hex').slice(0, 12);
}

function keys(account: string) {
  const net = networkKey();
  return {
    lock: `lock:src:${net}:${account}`,
    seq: `seq:${net}:${account}`,
    fence: `seq:${net}:${account}:fence`,
  };
}

function deps(override: Partial<SequenceDeps> = {}): Required<SequenceDeps> {
  const base: Required<SequenceDeps> = {
    rpc: override.rpc ?? testDeps?.rpc ?? rpcServer,
    redis: override.redis ?? testDeps?.redis ?? getRedis(),
    now: override.now ?? testDeps?.now ?? Date.now,
    sleep: override.sleep ?? testDeps?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    random: override.random ?? testDeps?.random ?? Math.random,
  };
  return base;
}

/**
 * Test seam: install fake RPC/Redis so the live write path can be exercised
 * without a running Redis or Stellar RPC. Call with null to restore.
 */
let testDeps: Partial<SequenceDeps> | null = null;
export function setSequenceDepsForTest(next: Partial<SequenceDeps> | null): void {
  testDeps = next;
}

/** Reads the account sequence from RPC and caches it. Returns the raw sequence. */
export async function syncSequence(account: string, override: Partial<SequenceDeps> = {}): Promise<bigint> {
  const d = deps(override);
  const remote = await d.rpc.getAccount(account);
  const seq = BigInt(remote.sequenceNumber());
  await d.redis.set(keys(account).seq, seq.toString());
  logger.info({ account, sequence: seq.toString() }, 'sequence: synced from RPC');
  return seq;
}

/**
 * Fair per-account critical section. In dry-run callers never reach this; the
 * lock covers one attempt from sequence allocation until the transaction has
 * left the point at which its sequence could be reused. It is not held across
 * any backoff sleep.
 */
export async function withSourceAccount<T>(
  account: string,
  fn: (ctx: SequenceContext) => Promise<T>,
  opts: { waitMs?: number; signal?: AbortSignal; deps?: Partial<SequenceDeps> } = {},
): Promise<T> {
  const d = deps(opts.deps);
  const { lock, seq: seqKey, fence: fenceKey } = keys(account);

  const alreadyHeld = heldAccounts.getStore();
  if (alreadyHeld?.has(account)) throw new SequenceReentrancy(account);

  let handle;
  try {
    handle = await acquireLock(lock, config.SEQ_LOCK_TTL_MS, opts.waitMs ?? config.SEQ_LOCK_WAIT_MS, {
      redis: d.redis,
      now: d.now,
      sleep: d.sleep,
      random: d.random,
    });
  } catch (err) {
    // Fail closed: never fall back to an unlocked submission.
    throw new ChainError(
      `could not take the source-account lock for ${account}`,
      null,
      { account, cause: err instanceof Error ? err.message : String(err) },
      'SEQUENCE_LOCK_UNAVAILABLE',
    );
  }
  if (!handle) {
    throw new ChainError(`timed out waiting for the source-account lock for ${account}`, null, {
      account,
      waitMs: opts.waitMs ?? config.SEQ_LOCK_WAIT_MS,
      retriable: true,
    }, 'SEQUENCE_LOCK_TIMEOUT');
  }

  const startedAt = d.now();
  let lost = false;
  const heartbeat = setInterval(() => {
    void renewLock(lock, handle!.token, config.SEQ_LOCK_TTL_MS, d.redis)
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch(() => {
        lost = true;
      });
  }, config.SEQ_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  const next = new Set(alreadyHeld ?? []);
  next.add(account);

  const advance = async (value: bigint) => {
    await advanceSequenceInRedis(seqKey, fenceKey, value, handle!.fence, d.redis);
  };

  // Read (or initialise) the cached sequence and hand the build an Account
  // carrying it; the SDK increments by one when it builds the transaction.
  let allocated = await currentSequence(account, seqKey, d);
  const accountObj = new Account(account, allocated.toString());

  const ctx: SequenceContext = {
    account: accountObj,
    fence: handle.fence,
    renew: async () => {
      const ok = await renewLock(lock, handle!.token, config.SEQ_LOCK_TTL_MS, d.redis);
      if (!ok) lost = true;
    },
    assertHeld: () => {
      if (lost) throw new SequenceLockLost(account);
    },
    advanceSequence: () => advance(allocated + 1n),
    resync: async () => {
      const fresh = await syncSequence(account, d);
      if (fresh > allocated) {
        // A newer holder advanced past us; adopt its value rather than regress.
        allocated = fresh;
        accountObj.sequenceNumber = () => fresh.toString();
      }
    },
  };

  try {
    return await heldAccounts.run(next, () => fn(ctx));
  } finally {
    clearInterval(heartbeat);
    const heldMs = d.now() - startedAt;
    if (heldMs > 10_000) logger.warn({ account, heldMs }, 'sequence: source-account lock held for a long time');
    await releaseLock(lock, handle.token, d.redis).catch((err) =>
      logger.error({ err, account }, 'sequence: failed to release source-account lock'),
    );
  }
}

async function currentSequence(account: string, seqKey: string, d: Required<SequenceDeps>): Promise<bigint> {
  const cached = await d.redis.get(seqKey);
  if (cached !== null) return BigInt(cached);
  return syncSequence(account, d);
}

/**
 * Rewrites an already-simulated transaction so it is built with the allocated
 * sequence number. `TransactionBuilder.cloneFrom` rebuilds the source account
 * from the existing sequence, so the source is replaced with one carrying
 * `allocated - 1` (the builder increments on build). Soroban data is not cloned
 * by `cloneFrom`, so it is re-applied.
 */
export function rebuildWithSequence(
  built: unknown,
  allocatedAccount: Account,
  networkPassphrase: string,
): unknown {
  const tx = built as { source?: string; toEnvelope?: () => any };
  if (!tx || typeof tx.toEnvelope !== 'function' || typeof tx.source !== 'string') {
    throw new ChainError('cannot supply the allocated sequence: assembled transaction has no built transaction', null, {}, 'SEQUENCE_SEAM_UNAVAILABLE');
  }
  const cloneFrom = (TransactionBuilder as unknown as { cloneFrom?: (t: unknown) => any }).cloneFrom;
  if (typeof cloneFrom !== 'function') {
    throw new ChainError(
      'cannot supply the allocated sequence: TransactionBuilder.cloneFrom is unavailable in this SDK',
      null,
      {},
      'SEQUENCE_SEAM_UNAVAILABLE',
    );
  }
  const sourceSeq = BigInt(allocatedAccount.sequenceNumber());
  const builder = cloneFrom(tx);
  (builder as { source: Account }).source = new Account(tx.source, (sourceSeq - 1n).toString());
  const sorobanData = sorobanDataOf(tx);
  if (sorobanData) builder.setSorobanData(sorobanData);
  builder.setNetworkPassphrase(networkPassphrase);
  return builder.build();
}

function sorobanDataOf(tx: unknown): unknown | undefined {
  try {
    const envelope = (tx as { toEnvelope: () => any }).toEnvelope();
    if (envelope.switch().name !== 'envelopeTypeTx') return undefined;
    const ext = envelope.v1().tx().ext();
    if (ext.switch().name === 'sorobanData') return ext.sorobanData();
  } catch {
    return undefined;
  }
  return undefined;
}
