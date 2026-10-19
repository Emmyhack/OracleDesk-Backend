/**
 * Entitlement-token revocation (#62).
 *
 * Tokens are short-lived, so expiry is the primary control. Revocation covers
 * the residual window when a pass is revoked, refunded or cancelled: the jti
 * is stored in Redis with a TTL equal to the token's remaining lifetime, so
 * the entry disappears exactly when the token would have expired anyway.
 *
 * The store fails closed. If Redis is unreachable, `isRevoked` throws and the
 * reference verifier treats the token as revoked. A missing revocation store
 * can therefore never turn a revoked token into a valid one.
 */
import { getRedis } from '../../lib/redis';
import { logger } from '../../lib/logger';

export interface RevocationStore {
  revoke(jti: string, ttlSeconds: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

export const REVOCATION_KEY_PREFIX = 'entitlement:revoked:';

export const redisRevocationStore: RevocationStore = {
  async revoke(jti, ttlSeconds) {
    if (ttlSeconds <= 0) return;
    await getRedis().set(`${REVOCATION_KEY_PREFIX}${jti}`, '1', 'EX', Math.ceil(ttlSeconds));
  },
  async isRevoked(jti) {
    const value = await getRedis().get(`${REVOCATION_KEY_PREFIX}${jti}`);
    return value !== null;
  },
};

let store: RevocationStore = redisRevocationStore;

/** Test seam. Returns a function that restores the previous store. */
export function setRevocationStore(next: RevocationStore): RevocationStore {
  const previous = store;
  store = next;
  return previous;
}

export async function revokeEntitlement(jti: string, ttlSeconds: number): Promise<void> {
  await store.revoke(jti, ttlSeconds);
}

export async function isEntitlementRevoked(jti: string): Promise<boolean> {
  return store.isRevoked(jti);
}

/**
 * Revokes every outstanding token for a user's subscription. Tokens are not
 * indexed by subscription, so this is a best-effort hook for callers that hold
 * a jti; the durable control remains the pass status (checkAccess).
 */
export async function revokeSubscriptionTokens(jtis: string[], expiresAt: Date): Promise<number> {
  const ttl = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  let revoked = 0;
  for (const jti of jtis) {
    try {
      await store.revoke(jti, ttl);
      revoked++;
    } catch (err) {
      logger.error({ err, jti }, 'Failed to revoke an entitlement token');
    }
  }
  return revoked;
}
