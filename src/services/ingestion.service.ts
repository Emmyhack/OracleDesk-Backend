import axios from 'axios';
import { logger } from '../lib/logger';
import { config } from '../config';
import { secret } from '../config/secrets';
import type { AggregatedSignal, AggregatedSignals } from '../types';
import { sanitizeSignal, sanitizeSignalText, MAX_CONTENT_CHARS, MAX_TITLE_CHARS, type SanitizedSignal } from './llm-guard.service';
import { bulkheads } from '../lib/resilience';
import { clockDeadline, now as clockNow, nowMs } from '../lib/clock';
import { canonicalJson, sha256Hex } from '../utils/hash.util';
import {
  canonicalUrl,
  classifyNewsCategory,
  dedupKeyForFred,
  dedupKeyForUrl,
  fingerprintText,
  parseGdeltDate,
  parseIsoDate,
  relevanceScore,
  simhash64,
  sourceWeight,
  type SignalSource,
} from './signal-normalize';
import {
  assignClusters,
  getSignalStore,
  type FetchStatus,
  type NormalizedSignal,
  type SignalRow,
} from './signal-store.service';

// ─── HTTP seam (#72) ──────────────────────────────────────────────────────────

/** The slice of an HTTP client the data sources use; tests replay recorded responses. */
export interface SignalHttp {
  get<T = any>(
    url: string,
    opts: { params?: Record<string, unknown>; timeout: number; signal?: AbortSignal },
  ): Promise<{ data: T }>;
}

export const axiosSignalHttp: SignalHttp = {
  get: (url, opts) => axios.get(url, opts),
};

let http: SignalHttp = axiosSignalHttp;

/** Test seam. Pass null to restore axios. Returns the previous client. */
export function setSignalHttp(next: SignalHttp | null): SignalHttp {
  const prev = http;
  http = next ?? axiosSignalHttp;
  return prev;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

export const NEWSAPI_URL = 'https://newsapi.org/v2/everything';
export const FRED_URL = 'https://api.stlouisfed.org/fred/series/observations';
export const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const FRED_SERIES = ['FEDFUNDS', 'CPIAUCSL', 'UNRATE', 'T10Y2Y'] as const;
export const GDELT_TIMEOUT_MS = 8_000;

const NEWS_QUERY = [
  'Federal Reserve OR ECB OR inflation OR "interest rates" OR GDP',
  'election OR parliament OR "political vote" OR president OR senate',
  'geopolitical OR sanctions OR treaty OR conflict',
  'bitcoin OR ethereum OR crypto OR "DeFi"',
  '"championship" OR "World Cup" OR "NBA Finals" OR "Super Bowl" OR "Premier League"',
  'Oscar OR Grammy OR Emmy OR "box office" OR "Billboard chart"',
].join(' OR ');

// ─── Credentials never reach storage ─────────────────────────────────────────

const CREDENTIAL_KEY = /^(?:api_?key|apikey|key|authorization|x-goog-api-key)$/i;
const SECRET_SOURCES = ['NEWSAPI_KEY', 'FRED_API_KEY'] as const;

/** Deep copy without credential-named keys. */
export function stripCredentials<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripCredentials) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !CREDENTIAL_KEY.test(k))
        .map(([k, v]) => [k, stripCredentials(v)]),
    ) as T;
  }
  return value;
}

/** Replaces configured key values inside free text (error messages, echoed URLs). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_SOURCES) {
    const value = secret(name);
    if (value) out = out.split(value).join('[REDACTED]');
  }
  return out.replace(/([?&](?:api_?key|apiKey)=)[^&\s]+/gi, '$1[REDACTED]');
}

const requestFingerprint = (url: string, params: Record<string, unknown>) =>
  sha256Hex(canonicalJson({ url, params: stripCredentials(params) }));

// ─── One provider call, recorded ──────────────────────────────────────────────

interface FetchOutcome {
  status: FetchStatus;
  items: NormalizedSignal[];
  rejected: number;
  raw?: unknown;
  error?: string;
}

/**
 * Runs one provider fetch and writes its provenance: a signal_fetches row and
 * (when there is a response) a credential-free raw payload, then upserts the
 * normalised rows and assigns clusters. Never throws for a provider failure.
 */
async function ingest(source: SignalSource, fingerprint: string, run: () => Promise<FetchOutcome>): Promise<NormalizedSignal[]> {
  const store = getSignalStore();
  const startedAt = clockNow();
  let outcome: FetchOutcome;
  try {
    outcome = await run();
  } catch (err: any) {
    outcome = { status: 'error', items: [], rejected: 0, error: scrubSecrets(String(err?.message ?? err)).slice(0, 500) };
  }
  const at = clockNow();
  if (outcome.items.length > 0) {
    const upserted = await store.upsert(outcome.items, at);
    await assignClusters(store, outcome.items, upserted, at);
  }
  await store
    .recordFetch({
      source,
      requestFingerprint: fingerprint,
      startedAt,
      durationMs: Math.max(0, at.getTime() - startedAt.getTime()),
      status: outcome.status,
      itemCount: outcome.items.length,
      rejectedCount: outcome.rejected,
      error: outcome.error ?? null,
      ...(outcome.raw !== undefined ? { rawPayload: stripCredentials(outcome.raw) } : {}),
    })
    .catch((err) => logger.warn({ err: (err as Error)?.message, source }, 'Failed to record signal fetch'));
  if (outcome.rejected > 0) logger.info({ source, rejected: outcome.rejected }, 'Signal items rejected at ingestion');
  return outcome.items;
}

/** The sanitised view of a normalised row (what fetchX callers and prompts see). */
function toSanitized(n: NormalizedSignal, relevance: number): SanitizedSignal {
  return sanitizeSignal({
    source: n.source,
    title: n.title,
    content: n.summary ?? '',
    publishedAt: n.publishedAt.toISOString(),
    relevanceScore: relevance,
    category: n.category ?? 'MACRO',
    ...(n.url ? { url: n.url } : {}),
  });
}

/**
 * Article text is attacker-controllable: it is sanitised before it is stored,
 * so the store only ever holds the clean text. URLs found in the text move to
 * `url` when the provider gave none.
 */
function normalizeArticle(
  source: SignalSource,
  a: { title: unknown; summary: unknown; url: unknown; publisher: unknown; publishedAt: Date },
): NormalizedSignal | null {
  const title = sanitizeSignalText(String(a.title ?? ''), MAX_TITLE_CHARS);
  const summary = sanitizeSignalText(String(a.summary ?? ''), MAX_CONTENT_CHARS);
  const url = canonicalUrl(typeof a.url === 'string' ? a.url : title.urls[0] ?? summary.urls[0]);
  if (!url || !title.text || title.text === '[Removed]') return null;
  const { category, confidence } = classifyNewsCategory(title.text);
  const publisher = typeof a.publisher === 'string' && a.publisher.trim() ? sanitizeSignalText(a.publisher, 80).text : null;
  return {
    source,
    dedupKey: dedupKeyForUrl(url),
    externalId: null,
    url,
    publisher,
    title: title.text,
    summary: summary.text || null,
    publishedAt: a.publishedAt,
    category,
    categoryConfidence: confidence,
    numericValue: null,
    simhash: simhash64(fingerprintText(title.text, summary.text)),
  };
}

// ─── NewsAPI ──────────────────────────────────────────────────────────────────

async function ingestNews(signal?: AbortSignal): Promise<NormalizedSignal[]> {
  const newsApiKey = secret('NEWSAPI_KEY');
  const params = { q: NEWS_QUERY, language: 'en', sortBy: 'publishedAt', pageSize: 30, apiKey: newsApiKey };
  return ingest('NEWSAPI', requestFingerprint(NEWSAPI_URL, params), async () => {
    if (!newsApiKey) {
      logger.warn('NEWSAPI_KEY not set — skipping news ingestion');
      return { status: 'skipped_no_key', items: [], rejected: 0 };
    }
    return bulkheads.datasource.run(async () => {
      try {
        const { data } = await http.get<{ articles?: any[] }>(NEWSAPI_URL, {
          params,
          timeout: config.TIMEOUT_DATASOURCE_MS,
          signal,
        });
        const articles = data?.articles ?? [];
        const items: NormalizedSignal[] = [];
        for (const article of articles) {
          const publishedAt = parseIsoDate(article?.publishedAt);
          const row = publishedAt && normalizeArticle('NEWSAPI', {
            title: article?.title,
            summary: article?.description ?? article?.content,
            url: article?.url,
            publisher: article?.source?.name,
            publishedAt,
          });
          if (row) items.push(row);
        }
        logger.info({ count: items.length }, 'Fetched news signals');
        return { status: 'ok' as const, items, rejected: articles.length - items.length, raw: data };
      } catch (err: any) {
        if (signal?.aborted) throw signal.reason;
        logger.error({ err: scrubSecrets(String(err?.message ?? err)) }, 'Failed to fetch NewsAPI signals');
        return { status: 'error' as const, items: [], rejected: 0, error: scrubSecrets(String(err?.message ?? err)).slice(0, 500) };
      }
    }, signal);
  });
}

// ─── FRED API ─────────────────────────────────────────────────────────────────

/** FRED marks a missing observation with "."; such rows are skipped, never stored as NaN. */
function validObservations(observations: any[]): Array<{ value: number; raw: string; date: string }> {
  return observations
    .filter((o) => typeof o?.value === 'string' && o.value !== '.' && Number.isFinite(Number(o.value)) && typeof o?.date === 'string')
    .map((o) => ({ value: Number(o.value), raw: o.value as string, date: o.date as string }));
}

async function ingestFred(signal?: AbortSignal): Promise<NormalizedSignal[]> {
  const fredApiKey = secret('FRED_API_KEY');
  const paramsFor = (seriesId: string) => ({
    series_id: seriesId,
    file_type: 'json',
    sort_order: 'desc',
    limit: 2,
    // In params, not concatenated into the URL, so it can be stripped from
    // every stored echo. axios serialises params in this order, so the request
    // URL is unchanged.
    ...(fredApiKey ? { api_key: fredApiKey } : {}),
  });
  return ingest('FRED', requestFingerprint(FRED_URL, { series: [...FRED_SERIES], ...paramsFor('*') }), async () => {
    const results = await Promise.allSettled(
      FRED_SERIES.map((seriesId) =>
        bulkheads.datasource.run(async () => {
          const { data } = await http.get<{ observations?: any[] }>(FRED_URL, {
            params: paramsFor(seriesId),
            timeout: config.TIMEOUT_DATASOURCE_MS,
            signal,
          });
          return { seriesId, data };
        }, signal),
      ),
    );

    const items: NormalizedSignal[] = [];
    const raw: Record<string, unknown> = {};
    let rejected = 0;
    let failures = 0;
    for (const r of results) {
      if (r.status === 'rejected') {
        failures++;
        continue;
      }
      const { seriesId, data } = r.value;
      raw[seriesId] = data;
      const all = data?.observations ?? [];
      const valid = validObservations(all);
      rejected += all.length - valid.length;
      const [latest, previous] = valid;
      if (!latest) continue;
      const change = previous ? latest.value - previous.value : 0;
      const publishedAt = parseIsoDate(latest.date);
      if (!publishedAt) {
        rejected++;
        continue;
      }
      items.push({
        source: 'FRED',
        dedupKey: dedupKeyForFred(seriesId, latest.date),
        externalId: seriesId,
        url: `https://fred.stlouisfed.org/series/${seriesId}`,
        publisher: 'FRED',
        title: `${seriesId}: ${latest.raw}`,
        summary: `${seriesId} = ${latest.raw} (${change >= 0 ? '+' : ''}${change.toFixed(3)} vs prior). Date: ${latest.date}`,
        publishedAt,
        category: 'FED',
        categoryConfidence: 1,
        numericValue: latest.value,
        simhash: null,
      });
    }
    logger.info({ count: items.length }, 'Fetched FRED signals');
    if (failures === FRED_SERIES.length) {
      const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      return { status: 'error', items, rejected, error: scrubSecrets(String(first?.reason?.message ?? first?.reason)).slice(0, 500) };
    }
    return { status: 'ok', items, rejected, raw };
  });
}

// ─── GDELT API ────────────────────────────────────────────────────────────────

async function ingestGdelt(signal?: AbortSignal): Promise<NormalizedSignal[]> {
  const params = {
    query: '"central bank" OR "interest rate" OR inflation OR election OR geopolitical',
    mode: 'artlist',
    format: 'json',
    maxrecords: 10,
    timespan: '1440',
  };
  return ingest('GDELT', requestFingerprint(GDELT_URL, params), async () => {
    // The deadline is a clock timer, so tests decide when it fires (#72).
    const handle = clockDeadline('datasource', signal, GDELT_TIMEOUT_MS);
    try {
      return await bulkheads.datasource.run(async () => {
        try {
          const { data } = await http.get<{ articles?: any[] }>(GDELT_URL, {
            params,
            timeout: GDELT_TIMEOUT_MS,
            signal: handle.signal,
          });
          handle.signal.throwIfAborted();
          const articles = data?.articles ?? [];
          const items: NormalizedSignal[] = [];
          for (const a of articles) {
            // seendate is YYYYMMDDTHHMMSSZ; an unparseable date is rejected, never stored as "now".
            const publishedAt = parseGdeltDate(a?.seendate);
            const row = publishedAt && normalizeArticle('GDELT', {
              title: a?.title,
              summary: '',
              url: a?.url,
              publisher: a?.domain,
              publishedAt,
            });
            if (row) items.push(row);
          }
          if (items.length > 0) logger.info({ count: items.length }, 'Fetched GDELT signals');
          return { status: 'ok' as const, items, rejected: articles.length - items.length, raw: data };
        } catch (err: any) {
          const isTimeout =
            handle.signal.aborted ||
            err?.code === 'ECONNABORTED' ||
            err?.code === 'ERR_CANCELED' ||
            err?.message?.includes('aborted');
          if (signal?.aborted) throw signal.reason;
          if (isTimeout) {
            logger.debug('GDELT timed out — continuing without macro signals this cycle');
            return { status: 'timeout' as const, items: [], rejected: 0, error: `timed out after ${GDELT_TIMEOUT_MS}ms` };
          }
          logger.warn({ err: err?.message }, 'GDELT fetch failed — continuing without macro signals');
          return { status: 'error' as const, items: [], rejected: 0, error: scrubSecrets(String(err?.message ?? err)).slice(0, 500) };
        }
      }, handle.signal);
    } finally {
      handle.cleanup?.();
    }
  });
}

// ─── Fetchers (each records provenance and writes the store) ─────────────────

const FETCHERS: Record<SignalSource, (signal?: AbortSignal) => Promise<NormalizedSignal[]>> = {
  NEWSAPI: ingestNews,
  FRED: ingestFred,
  GDELT: ingestGdelt,
};

const sanitizedNow = (items: NormalizedSignal[]) => {
  const at = clockNow();
  return items.map((n) => toSanitized(n, relevanceScore(n.source, n.source === 'FRED' ? at : n.publishedAt, 1, at)));
};

/** Fetches NewsAPI now and stores the result; returns what was fetched, sanitised. */
export async function fetchNewsSignals(signal?: AbortSignal): Promise<SanitizedSignal[]> {
  return sanitizedNow(await ingestNews(signal));
}

/** Fetches FRED (FEDFUNDS, CPIAUCSL, UNRATE, T10Y2Y) now and stores the result. */
export async function fetchFedData(signal?: AbortSignal): Promise<SanitizedSignal[]> {
  return sanitizedNow(await ingestFred(signal));
}

/** Fetches GDELT now (8 s deadline) and stores the result. */
export async function fetchMacroEvents(signal?: AbortSignal): Promise<SanitizedSignal[]> {
  return sanitizedNow(await ingestGdelt(signal));
}

/**
 * Fetches `source` unless it had a successful fetch within
 * SIGNAL_REFRESH_MINUTES. Returns whether a provider call was made.
 */
async function ensureFresh(source: SignalSource, signal?: AbortSignal): Promise<boolean> {
  const last = await getSignalStore().lastSuccessfulFetch(source);
  if (last && nowMs() - last.getTime() < config.SIGNAL_REFRESH_MINUTES * 60_000) {
    logger.debug({ source }, 'Signal source fresh — reading from the store');
    return false;
  }
  await FETCHERS[source](signal);
  return true;
}

// ─── Aggregator ───────────────────────────────────────────────────────────────

/** Signals older than this (by lastSeenAt) are not offered to the agents. */
export const AGGREGATE_WINDOW_HOURS = 24;
const LIMITS: Record<SignalSource, number> = { NEWSAPI: 50, FRED: 10, GDELT: 30 };

/**
 * Picks one representative per cluster from `rows` and scores it.
 *
 * - News/GDELT clusters: highest source weight, then newest.
 * - FRED: one row per series, the latest observation.
 *
 * relevanceScore = sourceWeight × recencyDecay × log2(1 + clusterSize); see
 * signal-normalize.ts. Results are sorted by relevance, highest first.
 */
export function representatives(rows: SignalRow[], now: Date): AggregatedSignal[] {
  const groups = new Map<string, SignalRow[]>();
  for (const r of rows) {
    const key = r.source === 'FRED' ? `FRED:${r.externalId ?? r.id}` : r.clusterId ?? r.id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: AggregatedSignal[] = [];
  for (const members of groups.values()) {
    const rep = [...members].sort((a, b) =>
      a.source === 'FRED'
        ? b.publishedAt.getTime() - a.publishedAt.getTime()
        : sourceWeight(b.source) - sourceWeight(a.source) || b.publishedAt.getTime() - a.publishedAt.getTime() || (a.id < b.id ? -1 : 1),
    )[0];
    const clusterSize = rep.source === 'FRED' ? 1 : members.length;
    const relevance = relevanceScore(rep.source, rep.source === 'FRED' ? rep.lastSeenAt : rep.publishedAt, clusterSize, now);
    out.push({
      ...toSanitized(rep, relevance),
      signalId: rep.id,
      publisher: rep.publisher,
      clusterSize,
    });
  }
  return out.sort((a, b) => b.relevanceScore - a.relevanceScore || (a.signalId < b.signalId ? -1 : 1));
}

/**
 * Refreshes stale sources, then reads the last AGGREGATE_WINDOW_HOURS of
 * signals from the store with one representative per near-duplicate cluster.
 *
 * The three refreshes run in parallel via Promise.allSettled so one slow
 * source never blocks the others; GDELT is the most likely to fail and the
 * cycle proceeds with news + FRED alone.
 */
export async function aggregateSignals(signal?: AbortSignal): Promise<AggregatedSignals> {
  const refreshed = await Promise.allSettled((Object.keys(FETCHERS) as SignalSource[]).map((s) => ensureFresh(s, signal)));
  for (const r of refreshed) {
    if (r.status === 'rejected') {
      if (signal?.aborted) throw signal.reason;
      logger.warn({ err: (r.reason as Error)?.message }, 'Signal refresh failed');
    }
  }

  const now = clockNow();
  const rows = await getSignalStore().recent(new Date(now.getTime() - AGGREGATE_WINDOW_HOURS * 3_600_000));
  const reps = representatives(rows, now);
  const pick = (source: SignalSource) => reps.filter((r) => r.source === source).slice(0, LIMITS[source]);
  const news = pick('NEWSAPI');
  const fed = pick('FRED');
  const macro = pick('GDELT');

  logger.info({ news: news.length, fed: fed.length, macro: macro.length, rows: rows.length }, 'Signals aggregated');
  return { news, fed, macro, aggregatedAt: now, signalCount: news.length + fed.length + macro.length };
}

export { classifyNewsCategory };
