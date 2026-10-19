import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { currentContext } from '../lib/context';
import { sendError } from '../utils/response.util';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global Express error handler.
 * Catches AppError instances, database integrity errors, and any unhandled errors.
 */
export function errorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Client aborted request
  if (err.name === 'ClientAbortedError' || (err instanceof AppError && err.code === 'CLIENT_ABORTED')) {
    logger.debug({ path: req.path, method: req.method }, 'Client aborted request');
    if (res.headersSent || req.socket?.destroyed) {
      return;
    }
    sendError(res, 499, 'CLIENT_ABORTED', 'Client aborted request');
    return;
  }

  // AppError instances
  if (err instanceof AppError) {
    logger.warn(
      { code: err.code, path: req.path, details: err.details, requestId: currentContext()?.requestId },
      err.message,
    );
    // #50: degraded dependencies tell clients when to retry.
    const retryAfter = err.details?.retryAfterSecs;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
    }
    // #50: advertise the PoW parameters alongside the 429.
    const powBits = err.details?.bits;
    if (err.code === 'POW_REQUIRED' && typeof powBits === 'number') {
      const salt = typeof err.details?.salt === 'string' ? err.details.salt : '';
      res.setHeader('X-Auth-PoW', `bits=${powBits}${salt ? `; salt=${salt}` : ''}`);
    }
    sendError(res, err.statusCode, err.code, err.message, err.details);
    return;
  }

  // Database integrity violations (Postgres 23514 check_violation, 23503 foreign_key_violation)
  const isPrismaIntegrity =
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2003' || err.code === 'P2004');

  const rawCode = (err as any)?.code || (err as any)?.originalError?.code;
  const isPostgresIntegrity = rawCode === '23514' || rawCode === '23503';
  const hasIntegrityMessage =
    typeof err.message === 'string' &&
    (err.message.includes('23514') ||
      err.message.includes('23503') ||
      err.message.includes('check constraint') ||
      err.message.includes('foreign key constraint'));

  if (isPrismaIntegrity || isPostgresIntegrity || hasIntegrityMessage) {
    const constraintMatch = err.message.match(/constraint ["']([^"']+)["']/i);
    const constraintName =
      (err as any)?.meta?.field_name || (err as any)?.meta?.target || constraintMatch?.[1] || 'unknown';

    logger.error(
      { err, constraint: constraintName, path: req.path, method: req.method },
      'Data integrity violation in database',
    );
    sendError(res, 500, 'DATA_INTEGRITY_VIOLATION', 'A database integrity violation occurred');
    return;
  }

  // Unexpected errors — log the full stack
  const requestId = currentContext()?.requestId ?? res.getHeader('X-Request-Id');
  logger.error({ err, path: req.path, method: req.method, requestId }, 'Unhandled error');
  sendError(res, 500, 'INTERNAL_ERROR', `An unexpected error occurred${requestId ? ` (reference: ${requestId})` : ''}`);
}