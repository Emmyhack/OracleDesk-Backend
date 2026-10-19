import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Runs `fn` on one instance at a time using a Postgres advisory lock. The lock
 * is held by an interactive transaction (`pg_try_advisory_xact_lock`), not a
 * session lock: with a connection pool, a session lock and its
 * `pg_advisory_unlock` can land on different connections and leak. The
 * transaction connection only holds the lock; `fn` does its own queries
 * through the provided transaction client.
 *
 * The lock is released when the transaction commits or rolls back, and by
 * Postgres when the connection dies, so a crashed holder can never block a
 * key forever.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { timeoutMs?: number; maxWaitMs?: number } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
      if (!rows[0]?.locked) return { acquired: false as const };
      return { acquired: true as const, value: await fn(tx) };
    },
    { timeout: opts.timeoutMs ?? 10 * 60_000, maxWait: opts.maxWaitMs ?? 5_000 },
  );
}

/**
 * Takes several advisory locks in one transaction. Keys are sorted before
 * acquisition so two callers requesting the same set can never deadlock.
 */
export async function withAdvisoryLocks<T>(
  keys: string[],
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { timeoutMs?: number; maxWaitMs?: number } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const ordered = [...new Set(keys)].sort();
  return prisma.$transaction(
    async (tx) => {
      for (const key of ordered) {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
        if (!rows[0]?.locked) return { acquired: false as const };
      }
      return { acquired: true as const, value: await fn(tx) };
    },
    { timeout: opts.timeoutMs ?? 10 * 60_000, maxWait: opts.maxWaitMs ?? 5_000 },
  );
}

/** Like withAdvisoryLockWait, for a set of keys acquired atomically. */
export async function withAdvisoryLocksWait<T>(
  keys: string[],
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { waitMs?: number; pollMs?: number; timeoutMs?: number; maxWaitMs?: number } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  const pollMs = opts.pollMs ?? 50;
  for (;;) {
    const result = await withAdvisoryLocks(keys, fn, { timeoutMs: opts.timeoutMs, maxWaitMs: opts.maxWaitMs });
    if (result.acquired) return result;
    if (Date.now() >= deadline) return { acquired: false };
    await sleep(pollMs);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Like withAdvisoryLock, but waits up to `waitMs` for a competing holder to
 * finish instead of failing immediately. Every retry is its own short
 * transaction, so a waiter never holds a connection while it sleeps.
 *
 * Returns `{ acquired: false }` only when the deadline passes. Callers must
 * treat that as a retryable 409/503, never as permission to proceed.
 */
export async function withAdvisoryLockWait<T>(
  key: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { waitMs?: number; pollMs?: number; timeoutMs?: number; maxWaitMs?: number } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  const pollMs = opts.pollMs ?? 50;
  for (;;) {
    const result = await withAdvisoryLock(key, fn, { timeoutMs: opts.timeoutMs, maxWaitMs: opts.maxWaitMs });
    if (result.acquired) return result;
    if (Date.now() >= deadline) return { acquired: false };
    await sleep(pollMs);
  }
}
