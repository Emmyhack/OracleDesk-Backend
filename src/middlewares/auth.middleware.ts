import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { previousSecret, secret } from '../config/secrets';
import { sendError } from '../utils/response.util';
import { currentContext } from '../lib/context';

export interface JwtPayload {
  userId: string;
  /**
   * Base G… account that signs and pays (#46). Kept as the compatibility claim
   * the rest of the app reads; a custodial sub-user's walletAddress is the
   * pooled account, not the M… / memo identity.
   */
  walletAddress: string;
  /** The signing account. Same as walletAddress; explicit for clarity. */
  account?: string;
  /** Muxed id or memo id as a decimal string (never a JS number). */
  subId?: string | null;
  subIdKind?: 'MUXED' | 'MEMO' | null;
  /**
   * Session account kind (#47). Absent on tokens issued before SEP-45 and
   * therefore treated as a classic G… account.
   */
  accountType?: 'account' | 'contract';
  iat: number;
  exp: number;
}

// Extend Express Request to carry the decoded JWT
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/** Only HS256 is accepted today. EdDSA verification is added in #44. */
const VERIFY_OPTIONS: jwt.VerifyOptions = { algorithms: ['HS256'] };

export type AuthError = 'missing' | 'expired' | 'invalid';

function decode(req: Request): { user?: JwtPayload; error?: AuthError } {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { error: 'missing' };
  return verifyAccessToken(authHeader.slice(7));
}

/**
 * Verifies a bearer token and returns the payload, or a machine-readable error.
 * Never lets an expired token fall back to the previous secret.
 */
export function verifyAccessToken(token: string): { user?: JwtPayload; error?: AuthError } {
  try {
    return { user: jwt.verify(token, secret('JWT_SECRET'), VERIFY_OPTIONS) as JwtPayload };
  } catch (err) {
    // Expiry is a property of the token, not the key. Never retry it with the
    // previous secret: that would turn an expired token into a valid one.
    if (err instanceof jwt.TokenExpiredError) return { error: 'expired' };
    if (!(err instanceof jwt.JsonWebTokenError)) return { error: 'invalid' };
    const previous = previousSecret('JWT_SECRET');
    if (!previous) return { error: 'invalid' };
    try {
      return { user: jwt.verify(token, previous, VERIFY_OPTIONS) as JwtPayload };
    } catch {
      return { error: 'invalid' };
    }
  }
}

/** Tag the request's log context with the caller (mutates this request's own store object). */
function setContextUser(userId: string): void {
  const ctx = currentContext();
  if (ctx) ctx.userId = userId;
}

/**
 * Require a valid JWT Bearer token. Attaches decoded payload to req.user.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const { user, error } = decode(req);
  if (user) {
    req.user = user;
    setContextUser(user.userId);
    next();
    return;
  }
  if (error === 'missing') sendError(res, 401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
  else if (error === 'expired') sendError(res, 401, 'TOKEN_EXPIRED', 'Token has expired');
  else sendError(res, 401, 'INVALID_TOKEN', 'Token is invalid');
}

/** Attaches req.user when a valid token is present; never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const { user } = decode(req);
  if (user) {
    req.user = user;
    setContextUser(user.userId);
  }
  next();
}

/**
 * Must run after requireAuth. Admins are the G… addresses in ADMIN_ADDRESSES,
 * compared exactly (StrKey is uppercase and case-sensitive).
 *
 * A custodial sub-user (#46) is never an admin, even when the pooled base
 * account is listed: admin rights are tied to the base account owner, not to
 * everyone the custodian signs for.
 */
function isAdmin(user: JwtPayload | undefined): boolean {
  if (!user) return false;
  // Contract accounts (#47) are never admins: ADMIN_ADDRESSES is G… only.
  if (user.accountType === 'contract') return false;
  if ((user.subIdKind ?? null) !== null) return false;
  return config.ADMIN_ADDRESSES.includes(user.walletAddress);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdmin(req.user)) {
    sendError(res, 403, 'FORBIDDEN', 'This action is limited to OracleDesk admins');
    return;
  }
  next();
}

/** True when `token` is a valid JWT for an admin address (used for the socket admin room). */
export function isAdminToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const { user } = verifyAccessToken(token);
  return isAdmin(user);
}

/**
 * Signer routes (#91). Only checks that a valid session exists: whether this
 * wallet is a signer of a given market depends on that market's committed spec,
 * so it is decided per market in signer-portal.service.ts after the market id
 * has been validated.
 */
export const requireSigner = requireAuth;

/** Identity claims carried by the access token (#46). */
export interface TokenIdentity {
  account?: string;
  subId?: string | null;
  subIdKind?: 'MUXED' | 'MEMO' | null;
  accountType?: 'account' | 'contract';
}

/**
 * Generate a signed JWT for a user. `walletAddress` stays the base G… account;
 * the optional identity adds the account/subId/subIdKind claims for custodial
 * sub-users. Kept as one token-issuing function so every call site gains the
 * EdDSA/`kid`/`iss`/`aud` layer (#44) and the session id (#43) at once.
 */
export function signToken(userId: string, walletAddress: string, identity: TokenIdentity = {}): string {
  const payload: Record<string, unknown> = {
    userId,
    walletAddress,
    account: identity.account ?? walletAddress,
  };
  if (identity.subId != null || identity.subIdKind != null) {
    payload.subId = identity.subId ?? null;
    payload.subIdKind = identity.subIdKind ?? null;
  }
  if (identity.accountType === 'contract') {
    payload.accountType = 'contract';
  }
  return jwt.sign(payload, secret('JWT_SECRET'), { expiresIn: '7d' });
}
