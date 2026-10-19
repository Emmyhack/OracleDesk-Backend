/**
 * Entitlement-token signing keys (#62).
 *
 * Tokens are signed with EdDSA (Ed25519) using a dedicated key that is NOT
 * JWT_SECRET, not AUTH_SIGNING_SECRET and not a wallet key. Keys are loaded
 * from config/env (or the secret store) in two shapes:
 *
 * - `ed25519-private:<base64 PKCS#8 DER>` (current or previous)
 * - `ed25519-public:<base64 SPKI DER>` (public only, for verification)
 *
 * A JWKS may publish any number of previous public keys; only one key is
 * current and signs new tokens. Key material is never logged and never
 * returned by the JWKS endpoint.
 */
import crypto from 'node:crypto';

export const ENTITLEMENT_ALG = 'EdDSA';
export const ENTITLEMENT_CURVE = 'Ed25519';

export interface EntitlementKey {
  kid: string;
  /** Private KeyObject for the current key; absent for public-only keys. */
  privateKey?: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

export interface EntitlementKeySet {
  current: EntitlementKey;
  /** Previous keys still accepted for verification, newest first. */
  previous: EntitlementKey[];
}

const PRIVATE_PREFIX = 'ed25519-private:';
const PUBLIC_PREFIX = 'ed25519-public:';

/** Stable, non-secret key id: the base64url SHA-256 of the SPKI public key. */
export function kidFor(publicKey: crypto.KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(spki).digest('base64url');
}

/** Parses one configured key value; throws with a message that never echoes it. */
export function parseEntitlementKey(value: string): EntitlementKey {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('is empty');
  const privatePart = trimmed.startsWith(PRIVATE_PREFIX) ? trimmed.slice(PRIVATE_PREFIX.length) : null;
  const publicPart = trimmed.startsWith(PUBLIC_PREFIX) ? trimmed.slice(PUBLIC_PREFIX.length) : null;

  if (privatePart !== null) {
    let privateKey: crypto.KeyObject;
    try {
      privateKey = crypto.createPrivateKey({
        key: Buffer.from(privatePart, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw new Error('is not a valid base64 PKCS#8 Ed25519 private key');
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('must be an Ed25519 private key');
    const publicKey = crypto.createPublicKey(privateKey);
    return { kid: kidFor(publicKey), privateKey, publicKey };
  }

  if (publicPart !== null) {
    let publicKey: crypto.KeyObject;
    try {
      publicKey = crypto.createPublicKey({ key: Buffer.from(publicPart, 'base64'), format: 'der', type: 'spki' });
    } catch {
      throw new Error('is not a valid base64 SPKI Ed25519 public key');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('must be an Ed25519 public key');
    return { kid: kidFor(publicKey), publicKey };
  }

  // A raw PEM private key is also accepted (secret-store friendly).
  if (trimmed.includes('-----BEGIN')) {
    let privateKey: crypto.KeyObject;
    try {
      privateKey = crypto.createPrivateKey(trimmed);
    } catch {
      throw new Error('is not a readable PEM private key');
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('must be an Ed25519 private key');
    const publicKey = crypto.createPublicKey(privateKey);
    return { kid: kidFor(publicKey), privateKey, publicKey };
  }

  throw new Error(`must start with ${PRIVATE_PREFIX} or ${PUBLIC_PREFIX}`);
}

/** A short, non-secret explanation of why a value cannot be used, or null. */
export function entitlementKeyProblem(value: string): string | null {
  try {
    parseEntitlementKey(value);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'is invalid';
  }
}

/**
 * Builds the active key set from config. `current` must contain a private key;
 * `previous` values may be private or public (private ones are reduced to the
 * public half). Duplicate kids are dropped so JWKS output stays unique.
 */
export function buildEntitlementKeySet(currentValue: string, previousValues: string[] = []): EntitlementKeySet {
  const current = parseEntitlementKey(currentValue);
  if (!current.privateKey) {
    throw new Error('ENTITLEMENT_SIGNING_KEY must contain the current private key, not only a public key');
  }
  const seen = new Set<string>([current.kid]);
  const previous: EntitlementKey[] = [];
  for (const value of previousValues) {
    if (!value.trim()) continue;
    const parsed = parseEntitlementKey(value);
    if (seen.has(parsed.kid)) continue;
    seen.add(parsed.kid);
    previous.push({ kid: parsed.kid, publicKey: parsed.publicKey });
  }
  return { current, previous };
}

/** JWK for a public key. Never includes private material. */
export function publicJwk(key: EntitlementKey): { kty: string; crv: string; x: string; kid: string; alg: string; use: string } {
  const jwk = key.publicKey.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string };
  if (jwk.kty !== 'OKP' || jwk.crv !== ENTITLEMENT_CURVE || !jwk.x) {
    throw new Error('Entitlement key is not an Ed25519 public key');
  }
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: key.kid, alg: ENTITLEMENT_ALG, use: 'sig' };
}

/** A JWKS document for the current and previous public keys. */
export function entitlementJwks(keys: EntitlementKeySet): { keys: ReturnType<typeof publicJwk>[] } {
  return { keys: [keys.current, ...keys.previous].map(publicJwk) };
}

/** Generates a new key value in the documented `ed25519-private:` format. */
export function generateEntitlementKey(): string {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return `${PRIVATE_PREFIX}${Buffer.from(der).toString('base64')}`;
}

/** The public half of a key value, in the `ed25519-public:` format. */
export function publicKeyValue(privateValue: string): string {
  const parsed = parseEntitlementKey(privateValue);
  const der = parsed.publicKey.export({ format: 'der', type: 'spki' });
  return `${PUBLIC_PREFIX}${Buffer.from(der).toString('base64')}`;
}
