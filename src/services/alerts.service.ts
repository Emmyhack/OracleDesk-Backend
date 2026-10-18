/**
 * Guardian alerts (#92).
 *
 * Sinks are pluggable (AlertSink). Two ship: a generic JSON webhook, signed
 * with HMAC-SHA256 so the receiver can verify the sender, and a
 * Slack-compatible incoming webhook. Email can be added as another sink.
 *
 * Delivery is deduplicated by AlertDelivery.dedupeKey = reviewId:level:sink,
 * stored in Postgres, so a restart or a second instance never re-sends an
 * alert that already went out. A failed delivery is retried with backoff and,
 * if it still fails, left FAILED so the next pass tries again.
 *
 * Webhook URLs carry tokens. They are never logged, never put in an error
 * message and never stored: a sink is identified by a short hash of its URL.
 */
import crypto from 'node:crypto';
import axios from 'axios';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export type AlertLevel = 'INFO' | 'WARN' | 'CRITICAL';

export interface Alert {
  level: AlertLevel;
  title: string;
  marketId: string;
  onChainMarketId: string;
  proposedOutcome: string;
  verdict: string;
  /** Seconds of dispute window left on the ledger clock; null when unknown. */
  windowRemainingSecs: number | null;
  links: { market: string; cancelTx: string };
  /** Free-text detail for humans: why this level, what to do. */
  detail?: string;
}

export interface AlertSink {
  /** Stable, secret-free identifier; part of the dedupe key. */
  name: string;
  send(alert: Alert): Promise<void>;
}

const SEND_TIMEOUT_MS = 5_000;
export const SIGNATURE_HEADER = 'X-OracleDesk-Signature';

/** A short, non-reversible id for a URL that must stay secret. */
function urlTag(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
}

/**
 * Strips everything that could identify the endpoint from an HTTP failure.
 * axios errors carry the request config (including the URL) on the error object.
 */
function safeFailure(err: unknown): string {
  const e = err as { code?: string; response?: { status?: number } } | null;
  if (e?.response?.status) return `HTTP ${e.response.status}`;
  if (e?.code) return String(e.code);
  return 'request failed';
}

export class SinkError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'SinkError';
  }
}

async function post(url: string, body: string, headers: Record<string, string>): Promise<void> {
  try {
    await axios.post(url, body, {
      headers: { 'content-type': 'application/json', ...headers },
      timeout: SEND_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch (err) {
    throw new SinkError(safeFailure(err));
  }
}

export function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function webhookSink(url: string, secret = config.ALERT_WEBHOOK_SECRET): AlertSink {
  return {
    name: `webhook-${urlTag(url)}`,
    async send(alert) {
      const body = JSON.stringify({ type: 'oracledesk.dispute_alert', sentAt: new Date().toISOString(), alert });
      await post(url, body, secret ? { [SIGNATURE_HEADER]: sign(secret, body) } : {});
    },
  };
}

const EMOJI: Record<AlertLevel, string> = { INFO: ':information_source:', WARN: ':warning:', CRITICAL: ':rotating_light:' };

export function slackSink(url: string): AlertSink {
  return {
    name: 'slack',
    async send(alert) {
      const remaining = alert.windowRemainingSecs === null ? 'unknown' : `${Math.max(0, Math.floor(alert.windowRemainingSecs / 60))} min`;
      const lines = [
        `${EMOJI[alert.level]} *${alert.level}* ${alert.title}`,
        `Market ${alert.onChainMarketId} · proposed ${alert.proposedOutcome} · verdict ${alert.verdict} · window left ${remaining}`,
        alert.detail,
        `Cancel transaction: ${alert.links.cancelTx}`,
      ].filter(Boolean);
      await post(url, JSON.stringify({ text: lines.join('\n') }), {});
    },
  };
}

export function sinksFromConfig(): AlertSink[] {
  const sinks: AlertSink[] = config.ALERT_WEBHOOK_URLS.map((url) => webhookSink(url));
  if (config.ALERT_SLACK_WEBHOOK_URL) sinks.push(slackSink(config.ALERT_SLACK_WEBHOOK_URL));
  return sinks;
}

export interface AlertServiceOptions {
  sinks?: AlertSink[];
  /** Attempts per sink per call, with exponential backoff between them. */
  attempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class AlertService {
  private readonly sinks: AlertSink[];
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AlertServiceOptions = {}) {
    this.sinks = opts.sinks ?? sinksFromConfig();
    this.attempts = opts.attempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get sinkNames(): string[] {
    return this.sinks.map((s) => s.name);
  }

  /** True when `level` for `reviewId` was already delivered by every sink. */
  async delivered(reviewId: string, level: AlertLevel): Promise<boolean> {
    if (this.sinks.length === 0) return false;
    const rows = await prisma.alertDelivery.findMany({ where: { reviewId, level, status: 'SENT' } });
    const sent = new Set(rows.map((r: { sink: string }) => r.sink));
    return this.sinks.every((s) => sent.has(s.name));
  }

  /**
   * Sends `alert` through every sink that has not delivered it yet.
   * Returns the sink names it newly delivered to.
   */
  async send(reviewId: string, alert: Alert): Promise<string[]> {
    if (this.sinks.length === 0) {
      logger.warn({ reviewId, level: alert.level, verdict: alert.verdict }, 'Dispute alert not delivered: no alert sinks configured');
      return [];
    }
    const delivered: string[] = [];
    for (const sink of this.sinks) {
      const dedupeKey = `${reviewId}:${alert.level}:${sink.name}`;
      const existing = await prisma.alertDelivery.findUnique({ where: { dedupeKey } });
      if (existing?.status === 'SENT') continue;

      let attempts = existing?.attempts ?? 0;
      let failure: string | null = null;
      for (let i = 0; i < this.attempts; i++) {
        attempts += 1;
        try {
          await sink.send(alert);
          failure = null;
          break;
        } catch (err) {
          failure = err instanceof SinkError ? err.reason : 'request failed';
          if (i < this.attempts - 1) await this.sleep(this.backoffMs * 2 ** i);
        }
      }

      const data = failure === null
        ? { status: 'SENT', attempts, sentAt: new Date(), error: null }
        : { status: 'FAILED', attempts, error: failure };
      await prisma.alertDelivery.upsert({
        where: { dedupeKey },
        create: { reviewId, level: alert.level, sink: sink.name, dedupeKey, ...data },
        update: data,
      });
      if (failure === null) delivered.push(sink.name);
      else logger.warn({ reviewId, level: alert.level, sink: sink.name, reason: failure }, 'Dispute alert delivery failed');
    }
    return delivered;
  }
}
