import { prisma } from './prisma';

/**
 * Runs `fn` on one instance at a time using a Postgres advisory lock. The lock
 * is held by an interactive transaction (`pg_try_advisory_xact_lock`), not a
 * session lock: with a connection pool, a session lock and its
 * `pg_advisory_unlock` can land on different connections and leak. The
 * transaction connection only holds the lock; `fn` does its own queries.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
      if (!rows[0]?.locked) return { acquired: false as const };
      return { acquired: true as const, value: await fn() };
    },
    { timeout: opts.timeoutMs ?? 10 * 60_000, maxWait: 5_000 },
  );
}
