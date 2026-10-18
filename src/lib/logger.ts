import pino from 'pino';
import { config } from '../config';
import { correlation, currentContext } from './context';

export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    config.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            messageFormat: '{if requestId}[{requestId}] {end}{msg}',
          },
        }
      : undefined,
  // Every line emitted inside a request/cron/job context carries its ids.
  mixin() {
    const ctx = currentContext();
    if (!ctx) return {};
    return { ...correlation(), kind: ctx.kind, ...(ctx.userId ? { userId: ctx.userId } : {}) };
  },
  // Never log credentials, even if a caller passes a whole request or config.
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'authorization',
      '*.JWT_SECRET',
      '*.AUTH_SIGNING_SECRET',
      '*.AGENT_SECRET_KEY',
      '*.PINATA_SECRET_API_KEY',
      '*.ANTHROPIC_API_KEY',
      '*.GEMINI_API_KEY',
      '*.OPENAI_API_KEY',
      'secret',
      'token',
    ],
    censor: '[redacted]',
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
});

export type Logger = typeof logger;