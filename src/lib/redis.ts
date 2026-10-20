import crypto from 'crypto';
import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

let client: Redis | null = null;
const blocking = new Set<Redis>();

/**
 * Thrown when Redis is down, slow or otherwise unable to serve a command.
 * Callers on the auth path map this to `503 AUTH_UNAVAILABLE` (#50).
 */
export class RedisUnavailableError extends Error {
  constructor(message = 'Redis is unavailable', public readonly cause?: unknown) {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

/** True when the shared client is connected and ready to serve commands. */
export function redisHealthy(): boolean {
  return client?.status === 'ready';
}

function isConnectionError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  const code = (err as { code?: string } | null)?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return (
    name === 'MaxRetriesPerRequestError' ||
    name === 'RedisUnavailableError' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'NR_CLOSED' ||
    /connection is closed|stream isn't writeable|command timed out|max retries/i.test(message)
  );
}

/**
 * Runs a Redis command, mapping connection/timeout failures to
 * {@link RedisUnavailableError}. Application errors (wrong type, script bugs)
 * pass through unchanged.
 */
export async function withRedis<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RedisUnavailableError) throw err;
    if (isConnectionError(err)) throw new RedisUnavailableError('Redis is unavailable', err);
    throw err;
  }
}

/**
 * Shared lazy Redis connection.
 *
 * `enableOfflineQueue: false` makes commands fail fast while disconnected
 * instead of piling up in memory; the auth path turns that into a 503 rather
 * than hanging a request handler.
 */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: config.REDIS_COMMAND_TIMEOUT_MS,
      connectTimeout: config.REDIS_CONNECT_TIMEOUT_MS,
      lazyConnect: false,
    });
    client.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));
    if (config.NODE_ENV === 'test') {
      // Unit tests run one process per file; a referenced Redis socket would
      // keep each process alive after its tests finish. Commands still work
      // on an unref'd socket.
      const c = client as unknown as { stream?: { unref?: () => void } };
      c.stream?.unref?.();
      client.on('connect', () => c.stream?.unref?.());
    }
  }
  return client;
}

/**
 * Warns when `maxmemory-policy` could evict non-TTL data (BullMQ, locks) to
 * make room for challenges. `NOPERM` on managed Redis is ignored.
 */
export async function checkRedisPolicy(): Promise<void> {
  try {
    const reply = await getRedis().config('GET', 'maxmemory-policy');
    const policy = Array.isArray(reply) ? String(reply[1]) : '';
    if (policy && !['volatile-ttl', 'volatile-lru', 'volatile-lfu', 'noeviction'].includes(policy)) {
      logger.warn(
        { policy },
        'Redis maxmemory-policy may evict non-TTL data (locks, queues); use volatile-ttl, volatile-lru or noeviction',
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/NOPERM|unknown command|not allowed/i.test(message)) {
      logger.warn({ err: message }, 'Could not read Redis maxmemory-policy');
    }
  }
}

/**
 * A new dedicated connection for blocking commands (XREAD BLOCK). A blocking
 * read on the shared client would stall every other command queued behind it,
 * such as the SEP-10 challenge GETDEL. The caller closes it with
 * releaseBlockingRedis(); closeRedis() closes any still open.
 */
export function getBlockingRedis(): Redis {
  const connection = getRedis().duplicate();
  connection.on('error', (err) => logger.error({ err: err.message }, 'Redis (blocking) error'));
  blocking.add(connection);
  return connection;
}

export function releaseBlockingRedis(connection: Redis): void {
  blocking.delete(connection);
  // disconnect() also aborts a command blocked in XREAD.
  connection.disconnect();
}

export async function closeRedis(): Promise<void> {
  for (const connection of blocking) connection.disconnect();
  blocking.clear();
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}

// ─── Distributed lock primitives (#36) ───────────────────────────────────────

/**
 * Extend the TTL of a held lock, but only if this call still owns it. Exposed
 * as a constant so the in-memory test double can recognise and execute it.
 */
export const RENEW_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end`;

/** Delete a lock, but only if this call still owns it (compare-and-delete). */
export const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

/**
 * Write a cached sequence number, but only when the caller's fencing token is
 * at least as new as the token that last wrote it. A holder that lost its lock
 * (and therefore its token is older) can never move the sequence backwards.
 */
export const ADVANCE_SEQUENCE_SCRIPT = `
local stored = redis.call('GET', KEYS[2])
if stored and tonumber(stored) > tonumber(ARGV[2]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return 1`;

export interface LockHandle {
  /** Unpredictable owner token; the lock value. */
  token: string;
  /** Monotonic fencing token, ordered across all acquisitions of this lock. */
  fence: number;
}

export interface AcquireLockDeps {
  redis?: Redis;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source for deterministic tests. Returns [0, 1). */
  random?: () => number;
}

const LOCK_POLL_MS = 50;
const LOCK_POLL_JITTER_MS = 25;

/**
 * Fair, FIFO per-key lock. Waiters take a monotonic ticket from
 * `<key>:fence`, push it onto the `<key>:queue` sorted set and only the head of
 * that queue tries to take the lock, so a busy cron cannot starve an admin
 * call. The lock itself is a single `SET NX PX` so a crashed holder cannot
 * block the queue for longer than its TTL.
 *
 * Returns null when `waitMs` elapses without acquiring.
 */
export async function acquireLock(
  key: string,
  ttlMs: number,
  waitMs: number,
  deps: AcquireLockDeps = {},
): Promise<LockHandle | null> {
  const redis = deps.redis ?? getRedis();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  const token = crypto.randomUUID();
  const fence = await redis.incr(`${key}:fence`);
  const member = `${fence}:${token}`;
  const queueKey = `${key}:queue`;
  await redis.zadd(queueKey, fence, member);
  const deadline = now() + waitMs;

  try {
    for (;;) {
      const head = await redis.zrange(queueKey, 0, 0);
      if (head.length > 0 && head[0] === member) {
        const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
        if (acquired === 'OK') {
          await redis.zrem(queueKey, member);
          return { token, fence };
        }
      }
      if (now() >= deadline) return null;
      await sleep(LOCK_POLL_MS + Math.floor(random() * LOCK_POLL_JITTER_MS));
    }
  } catch (err) {
    await redis.zrem(queueKey, member).catch(() => undefined);
    throw err;
  }
}

/** Renew a held lock. False when it has already expired or been taken over. */
export async function renewLock(key: string, token: string, ttlMs: number, redis: Redis = getRedis()): Promise<boolean> {
  const result = await redis.eval(RENEW_LOCK_SCRIPT, 1, key, token, String(ttlMs));
  return Number(result) === 1;
}

/** Release a held lock (no-op if it was already lost). */
export async function releaseLock(key: string, token: string, redis: Redis = getRedis()): Promise<void> {
  await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
}

/** Advance the cached sequence to `seq`, fenced by `fence`. */
export async function advanceSequence(
  seqKey: string,
  fenceKey: string,
  seq: bigint,
  fence: number,
  redis: Redis = getRedis(),
): Promise<boolean> {
  const result = await redis.eval(ADVANCE_SEQUENCE_SCRIPT, 2, seqKey, fenceKey, seq.toString(), String(fence));
  return Number(result) === 1;
}
