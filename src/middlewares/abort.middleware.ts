import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { ClientAbortedError, TimeoutError } from '../lib/resilience';

declare global {
  namespace Express {
    interface Request {
      signal: AbortSignal;
    }
  }
}

export function abortMiddleware(req: Request, res: Response, next: NextFunction): void {
  const controller = new AbortController();
  // Node ≥24 defines a getter-only IncomingMessage.prototype.signal, so a
  // plain assignment throws there; an own property shadows the getter on
  // every Node version.
  Object.defineProperty(req, 'signal', { value: controller.signal, configurable: true, enumerable: true });

  let timer: NodeJS.Timeout | null = setTimeout(() => {
    timer = null;
    if (!res.headersSent && !res.writableEnded) {
      controller.abort(new TimeoutError('rpc-read', config.HTTP_REQUEST_TIMEOUT_MS));
    }
  }, config.HTTP_REQUEST_TIMEOUT_MS);

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  req.on('close', () => {
    cleanup();
    if (!res.writableEnded) {
      controller.abort(new ClientAbortedError());
    }
  });

  res.on('finish', cleanup);
  res.on('close', cleanup);

  next();
}
