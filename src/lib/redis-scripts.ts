/**
 * Atomic Redis scripts for auth challenge issuance (#50).
 *
 * Every key in the `auth:{auth}:` namespace shares one Redis Cluster slot, so
 * a script may touch all of them (including the challenge key it evicts) while
 * remaining cluster-safe. Members of the outstanding sets are scored by their
 * expiry so stale entries are pruned on every call.
 */

/** `auth:{auth}:` — the hash tag keeps every auth key in the same slot. */
export const AUTH_KEY_PREFIX = 'auth:{auth}:';

export const AUTH_CHALLENGE_PREFIX = `${AUTH_KEY_PREFIX}challenge:`;
export const AUTH_ADDRESS_PREFIX = `${AUTH_KEY_PREFIX}outstanding:addr:`;
export const AUTH_IP_PREFIX = `${AUTH_KEY_PREFIX}outstanding:ip:`;
export const AUTH_ISSUED_PREFIX = `${AUTH_KEY_PREFIX}issued:`;
export const AUTH_POW_PREFIX = `${AUTH_KEY_PREFIX}pow:`;

export const authChallengeKey = (hash: string) => `${AUTH_CHALLENGE_PREFIX}${hash}`;
export const authAddressKey = (address: string) => `${AUTH_ADDRESS_PREFIX}${address}`;
export const authIpKey = (ipHash: string) => `${AUTH_IP_PREFIX}${ipHash}`;
export const authIssuedKey = (minute: number) => `${AUTH_ISSUED_PREFIX}${minute}`;
export const authPowKey = (salt: string) => `${AUTH_POW_PREFIX}${salt}`;

/**
 * Issue a challenge and account for it atomically.
 *
 * KEYS[1] challenge key, KEYS[2] address zset, KEYS[3] IP zset,
 * KEYS[4] global per-minute counter.
 * ARGV[1] record, ARGV[2] ttl seconds, ARGV[3] now ms, ARGV[4] max per
 * address, ARGV[5] max per IP, ARGV[6] challenge key prefix, ARGV[7] hash.
 *
 * Returns `{1, globalCount}` on success and `{-1, globalCount}` when the IP
 * cap is hit. The address cap never refuses: it evicts the oldest outstanding
 * challenge for that address, so an attacker spamming a victim cannot lock the
 * victim out of obtaining a fresh challenge.
 */
export const ISSUE_CHALLENGE_SCRIPT = `
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[2])
local maxAddr = tonumber(ARGV[4])
local maxIp = tonumber(ARGV[5])
local expires = now + ttl * 1000

redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)

local ipCount = redis.call('ZCARD', KEYS[3])
if ipCount >= maxIp then
  return {-1, tonumber(redis.call('GET', KEYS[4]) or '0')}
end

while redis.call('ZCARD', KEYS[2]) >= maxAddr do
  local oldest = redis.call('ZPOPMIN', KEYS[2])
  if not oldest or #oldest == 0 then break end
  local victim = oldest[1]
  redis.call('DEL', ARGV[6] .. victim)
  redis.call('ZREM', KEYS[3], victim)
end

redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
redis.call('ZADD', KEYS[2], expires, ARGV[7])
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('ZADD', KEYS[3], expires, ARGV[7])
redis.call('EXPIRE', KEYS[3], ttl)
local issued = redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], 120)
return {1, issued}
`;

export interface IssueChallengeResult {
  ok: boolean;
  ipLimited: boolean;
  globalCount: number;
}
