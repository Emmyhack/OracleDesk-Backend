import { randomBytes } from 'node:crypto';

/**
 * A per-file key prefix so `auth:challenge:*` keys from files running in
 * parallel never collide. The store below issues the same real SET EX / GETDEL
 * commands as `redisChallengeStore`, just under the prefix.
 */
export async function withRedisPrefix(label: string) {
  const { getRedis } = await import('../../src/lib/redis');
  type ChallengeRecord = import('../../src/services/auth.service').ChallengeRecord;
  const prefix = `test:${label}:${randomBytes(3).toString('hex')}:`;
  return {
    prefix,
    store: {
      async put(hash: string, record: import('../../src/services/auth.service').ChallengeRecord, ttl: number) {
        await getRedis().set(`${prefix}auth:challenge:${hash}`, JSON.stringify(record), 'EX', ttl);
      },
      async take(hash: string) {
        const raw = await getRedis().getdel(`${prefix}auth:challenge:${hash}`);
        return raw === null ? null : (JSON.parse(raw) as import('../../src/services/auth.service').ChallengeRecord);
      },
    },
    /** Deletes this file's keys with SCAN + UNLINK. */
    async flushPrefix() {
      const redis = getRedis();
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        if (keys.length) await redis.unlink(...keys);
        cursor = next;
      } while (cursor !== '0');
    },
  };
}
