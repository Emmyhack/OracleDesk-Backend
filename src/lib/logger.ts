import pino from 'pino';
import { config } from '../config';
import { correlation, currentContext } from './context';

/**
 * Webhook URLs (#92) embed tokens, so they are redacted along with the secrets,
 * both as config values and as the fields an HTTP client error carries.
 */
export const LOG_REDACT = {
  paths: [
    'req.headers.authorization',
    'headers.authorization',
    'authorization',
    '*.JWT_SECRET',
    '*.AUTH_SIGNING_SECRET',
    '*.AGENT_SECRET_KEY',
    '*.FEE_PAYER_SECRET',
    '*.CHANNEL_SECRET_KEYS',
    'CHANNEL_SECRET_KEYS',
    '*.channelSecret',
    'channelSecret',
    '*.channelKey',
    'channelKey',
    '*.PINATA_SECRET_API_KEY',
    '*.ANTHROPIC_API_KEY',
    '*.GEMINI_API_KEY',
    '*.ALERT_WEBHOOK_URLS',
    '*.ALERT_SLACK_WEBHOOK_URL',
    '*.ALERT_WEBHOOK_SECRET',
    'ALERT_WEBHOOK_URLS',
    'ALERT_SLACK_WEBHOOK_URL',
    'ALERT_WEBHOOK_SECRET',
    'webhookUrl',
    '*.webhookUrl',
    'webhookSecret',
    '*.webhookSecret',
    'err.config.url',
    'err.config.headers',
    'err.config.data',
    'err.request',
    'secret',
    'token',
  ],
  censor: '[redacted]',
};

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
      '*.FEE_PAYER_SECRET',
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