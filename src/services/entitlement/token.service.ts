/**
 * Signed trace-entitlement tokens (#62, backend half).
 *
 * A daily-pass holder asks the backend for a short-lived token and presents it
 * to the x402 trace service instead of paying again. The token is a compact
 * JWS with an EdDSA (Ed25519) signature from a dedicated key, never JWT_SECRET
 * and never a wallet key. Verification keys are published at GET /jwks.
 *
 * The token carries only the user's Stellar address (already public), the
 * backend trace id and the on-chain trace id. No email, no user id, no PII.
 */
import crypto from 'node:crypto';
import { config } from '../../config';
import { secret } from '../../config/secrets';
import { logger } from '../../lib/logger';
import { AppError } from '../../middlewares/error.middleware';
import {
  buildEntitlementKeySet,
  entitlementJwks,
  type EntitlementKeySet,
} from './keys';

export const ENTITLEMENT_ISSUER = 'oracledesk-backend';
export const ENTITLEMENT_HEADER = 'X-OracleDesk-Entitlement';

const b64url = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64url');

export interface EntitlementClaims {
  iss: string;
  aud: string;
  sub: string;
  traceId: string;
  onChainTraceId: string | null;
  jti: string;
  iat: number;
  exp: number;
}

export interface IssuedEntitlement {
  token: string;
  expiresAt: Date;
  kid: string;
  header: string;
}

export interface EntitlementDeps {
  keys(): EntitlementKeySet;
  now(): number;
  jti(): string;
}

let deps: EntitlementDeps = {
  keys: () => {
    const current = secret('ENTITLEMENT_SIGNING_KEY');
    if (!current) {
      throw new AppError(
        503,
        'ENTITLEMENT_KEYS_UNAVAILABLE',
        'Trace entitlement tokens are not configured on this server',
      );
    }
    return buildEntitlementKeySet(current, config.ENTITLEMENT_PREVIOUS_PUBLIC_KEYS);
  },
  now: () => Date.now(),
  jti: () => crypto.randomUUID(),
};

/** Test seam. Returns a function that restores the previous dependencies. */
export function setEntitlementDeps(next: Partial<EntitlementDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => {
    deps = previous;
  };
}

function signingInput(header: string, payload: string): string {
  return `${header}.${payload}`;
}

/**
 * Mints a token for a trace the caller already proved access to.
 *
 * The lifetime is `ENTITLEMENT_TOKEN_TTL_SECONDS`, capped by the remaining
 * pass time, so a token never outlives the entitlement it represents.
 */
export function issueEntitlementToken(params: {
  subject: string;
  traceId: string;
  onChainTraceId: string | null;
  expiresAt: Date | null | undefined;
}): IssuedEntitlement {
  const now = Math.floor(deps.now() / 1000);
  const configuredTtl = config.ENTITLEMENT_TOKEN_TTL_SECONDS;
  let exp = now + configuredTtl;
  if (params.expiresAt) {
    const passExpiry = Math.floor(params.expiresAt.getTime() / 1000);
    exp = Math.min(exp, passExpiry);
  }
  if (exp <= now) {
    throw new AppError(403, 'NO_ACCESS', 'The pass has expired; no entitlement token can be issued');
  }

  const keySet = deps.keys();
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: keySet.current.kid }));
  const claims: EntitlementClaims = {
    iss: ENTITLEMENT_ISSUER,
    aud: config.X402_ENTITLEMENT_AUDIENCE,
    sub: params.subject,
    traceId: params.traceId,
    onChainTraceId: params.onChainTraceId,
    jti: deps.jti(),
    iat: now,
    exp,
  };
  const payload = b64url(JSON.stringify(claims));
  const input = signingInput(header, payload);
  if (!keySet.current.privateKey) {
    throw new AppError(503, 'ENTITLEMENT_KEYS_UNAVAILABLE', 'The entitlement signing key is not configured');
  }
  const signature = crypto.sign(null, Buffer.from(input), keySet.current.privateKey);
  return {
    token: `${input}.${b64url(signature)}`,
    expiresAt: new Date(exp * 1000),
    kid: keySet.current.kid,
    header: ENTITLEMENT_HEADER,
  };
}

/** Public JWKS document; never contains private material. */
export function getEntitlementJwks(): { keys: ReturnType<typeof entitlementJwks>['keys'] } {
  try {
    return entitlementJwks(deps.keys());
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Entitlement JWKS unavailable');
    throw new AppError(503, 'ENTITLEMENT_KEYS_UNAVAILABLE', 'Trace entitlement verification keys are not configured');
  }
}

// ─── Reference verifier ──────────────────────────────────────────────────

export type EntitlementVerificationFailure =
  | 'MALFORMED'
  | 'ALGORITHM_NOT_ALLOWED'
  | 'UNKNOWN_KID'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'WRONG_ISSUER'
  | 'WRONG_AUDIENCE'
  | 'WRONG_TRACE'
  | 'REVOKED';

export interface EntitlementJwk {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  alg?: string;
  use?: string;
}

export interface VerifyEntitlementParams {
  token: string;
  jwks: { keys: EntitlementJwk[] };
  audience: string;
  traceId: string;
  /** Clock skew tolerance in seconds (default 30). */
  clockSkewSeconds?: number;
  /** Returns true when the token's jti was revoked. Fail closed on error. */
  isRevoked?: (jti: string) => Promise<boolean>;
  now?: () => number;
  issuer?: string;
}

export type EntitlementVerification =
  | { valid: true; claims: EntitlementClaims; kid: string }
  | { valid: false; reason: EntitlementVerificationFailure };

const ALLOWED_ALGS = new Set(['EdDSA']);

/**
 * Standalone reference verifier. It is deliberately strict:
 *
 * - only EdDSA is accepted (`none`, HS256 and algorithm confusion are refused
 *   before any key is looked up);
 * - the signature must match a published `kid`;
 * - `exp` is required and enforced, `nbf` is enforced when present;
 * - `iss`, `aud` and `traceId` must match exactly;
 * - a revocation lookup that throws is treated as revoked (fail closed).
 */
export async function verifyEntitlementToken(params: VerifyEntitlementParams): Promise<EntitlementVerification> {
  const parts = params.token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'MALFORMED' };

  let header: { alg?: unknown; kid?: unknown; typ?: unknown };
  let claims: Partial<EntitlementClaims> & { nbf?: unknown };
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'MALFORMED' };
  }
  if (typeof header.alg !== 'string' || !ALLOWED_ALGS.has(header.alg)) {
    return { valid: false, reason: 'ALGORITHM_NOT_ALLOWED' };
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return { valid: false, reason: 'MALFORMED' };
  }

  const jwk = params.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { valid: false, reason: 'UNKNOWN_KID' };
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }

  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
  } catch {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(signingInput(parts[0], parts[1])),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { valid: false, reason: 'BAD_SIGNATURE' };

  const now = Math.floor((params.now ?? Date.now)() / 1000);
  const skew = params.clockSkewSeconds ?? 30;
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return { valid: false, reason: 'MALFORMED' };
  }
  if (now - skew >= claims.exp) return { valid: false, reason: 'EXPIRED' };
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || now + skew < claims.nbf) {
      return { valid: false, reason: 'NOT_YET_VALID' };
    }
  }
  if (claims.iss !== (params.issuer ?? ENTITLEMENT_ISSUER)) return { valid: false, reason: 'WRONG_ISSUER' };
  if (claims.aud !== params.audience) return { valid: false, reason: 'WRONG_AUDIENCE' };
  if (claims.traceId !== params.traceId) return { valid: false, reason: 'WRONG_TRACE' };
  if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
    return { valid: false, reason: 'MALFORMED' };
  }

  if (params.isRevoked) {
    let revoked: boolean;
    try {
      revoked = await params.isRevoked(claims.jti);
    } catch {
      // Fail closed: if revocation cannot be checked, the token is not trusted.
      revoked = true;
    }
    if (revoked) return { valid: false, reason: 'REVOKED' };
  }

  return { valid: true, claims: claims as EntitlementClaims, kid: header.kid };
}
