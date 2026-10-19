import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import hpp from 'hpp';

import { config } from './config';
import { logger } from './lib/logger';
import { acceptInboundId, currentContext, newId, runInContext, runWithContext } from './lib/context';
import { sendError } from './utils/response.util';
import { errorMiddleware } from './middlewares/error.middleware';
import { globalLimiter } from './middlewares/rate-limit.middleware';
import { abortMiddleware } from './middlewares/abort.middleware';
import router from './routes';
import { createHealthRouter } from './routes/health.routes';
import { health } from './services/health.service';

const app = express();

// #50: behind a proxy, `req.ip` must be the client, not the load balancer.
// TRUST_PROXY is an Express `trust proxy` value ("true", a hop count, or a
// comma list of addresses/subnets). Left unset, Express uses the socket peer.
if (config.TRUST_PROXY) {
  const raw = config.TRUST_PROXY.trim();
  const value = raw === 'true' ? true : /^\d+$/.test(raw) ? Number(raw) : raw.split(',').map((s) => s.trim()).filter(Boolean);
  app.set('trust proxy', value);
}

// BigInt (u64 market ids, i128 amounts) serialises as a decimal string.
app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));

// ─── Liveness / Readiness (#111) ───
// Before the rate limiter, compression and CORS: orchestrators poll often from one IP.
app.use(createHealthRouter(health));

// ─── Security ───
app.use(helmet());
app.use(hpp());
app.use(cors({
  // Explicit allowlist from CORS_ORIGINS; never "*" with credentials.
  origin: (origin, callback) => {
    // Requests without an Origin header (curl, server-to-server) carry no
    // browser credentials, so CORS doesn't apply to them.
    if (!origin || config.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
  // #123: let browsers send Idempotency-Key and read Idempotent-Replayed.
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  exposedHeaders: ['Idempotent-Replayed', 'Retry-After', 'X-Request-Id'],
}));

// ─── Rate Limiting ───
app.use(globalLimiter);

// ─── Body Parsing + Compression ───
app.use(compression());
app.use(express.json({ limit: '1mb' }));
// Stream-based body parsing can resume handlers outside the request's async
// context; re-enter it so everything downstream stays correlated.
app.use((_req, res, next) => runInContext(res.locals.requestContext, next));

// ─── HTTP Logging ───
// Paths only: the route template, never the query string or referrer.
app.use((req, res, next) => {
  if (config.NODE_ENV !== 'test') {
    const ctx = currentContext();
    res.on('finish', () => {
      const log = () =>
        logger.info(
          {
            method: req.method,
            route: req.route ? req.baseUrl + req.route.path : 'unmatched',
            status: res.statusCode,
            durationMs: Date.now() - (ctx?.startedAt ?? Date.now()),
            contentLength: res.getHeader('content-length'),
          },
          'http',
        );
      // 'finish' listeners may not run inside the request's context.
      if (ctx) runInContext(ctx, log);
      else log();
    });
  }
  next();
});

// ─── Request Timeout & Abort Signal ───
app.use(abortMiddleware);

// ─── Health Check ───
// Deprecated in favour of /livez and /readyz; response shape is unchanged.
app.get('/health', (_req, res) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</readyz>; rel="successor-version"');
  res.json({ ok: true, data: { status: 'healthy', uptime: process.uptime() }, error: null });
});

// ─── API Routes ───
app.use('/api/v1', router);

// ─── 404 Handler ───
app.use((_req, res) => {
  sendError(res, 404, 'NOT_FOUND', 'Route not found');
});

// ─── Global Error Handler ───
app.use(errorMiddleware);

export default app;
