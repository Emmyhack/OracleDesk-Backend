import rateLimit from 'express-rate-limit';
import { config } from '../config';

const body = (requestId?: string) => ({
  ok: false,
  data: null,
  error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', requestId },
});

const limiter = (windowMs: number, limit: number) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: (_req: unknown, res: { getHeader(name: string): unknown }) => {
      const id = res.getHeader('X-Request-Id');
      return body(typeof id === 'string' ? id : undefined);
    },
    skip: () => config.NODE_ENV === 'test',
  });

/** Whole API: 200 requests per 15 minutes per IP. */
export const globalLimiter = limiter(15 * 60 * 1000, 200);
/** /auth/*: 20 requests per 5 minutes per IP. */
export const authLimiter = limiter(5 * 60 * 1000, 20);
/** /markets/generate: 5 per hour per IP (each run calls paid LLM APIs). */
export const generateLimiter = limiter(60 * 60 * 1000, 5);

/** /signer/*: 30 requests per minute per IP (each prepare simulates against RPC). */
export const signerLimiter = limiter(60 * 1000, 30);
