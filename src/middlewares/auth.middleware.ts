import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { previousSecret, secret, secretEntry } from '../config/secrets';
import { sendError } from '../utils/response.util';
import { currentContext } from '../lib/context';

export interface JwtPayload {
  userId: string;
  walletAddress: string;
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

function decode(req: Request): { user?: JwtPayload; error?: 'missing' | 'expired' | 'invalid' } {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { error: 'missing' };
  return verifyBearer(authHeader.slice(7));
}

function verifyBearer(token: string): { user?: JwtPayload; error?: 'missing' | 'expired' | 'invalid' } {
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

function decode(req: Request): { user?: JwtPayload; error?: 'missing' | 'expired' | 'invalid' } {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { error: 'missing' };
  return verifyAccessToken(authHeader.slice(7));
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
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !config.ADMIN_ADDRESSES.includes(req.user.walletAddress)) {
    sendError(res, 403, 'FORBIDDEN', 'This action is limited to OracleDesk admins');
    return;
  }
  next();
}

/** True when `token` is a valid JWT for an admin address (used for the socket admin room). */
export function isAdminToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const { user } = verifyBearer(token);
  return Boolean(user && config.ADMIN_ADDRESSES.includes(user.walletAddress));
}

/**
 * Signer routes (#91). Only checks that a valid session exists: whether this
 * wallet is a signer of a given market depends on that market's committed spec,
 * so it is decided per market in signer-portal.service.ts after the market id
 * has been validated.
 */
export const requireSigner = requireAuth;

/**
 * Generate a signed JWT for a user
 */
export function signToken(userId: string, walletAddress: string): string {
  return jwt.sign({ userId, walletAddress }, secret('JWT_SECRET'), { expiresIn: '7d' });
}
