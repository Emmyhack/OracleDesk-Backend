import axios from 'axios';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { secret } from '../config/secrets';
import type { RawSignal, AggregatedSignals } from '../types';
import { sanitizeSignal, type SanitizedSignal } from './llm-guard.service';
import { bulkheads, deadline } from '../lib/resilience';
import dayjs from 'dayjs';

const CACHE_TTL_MINUTES = 20; // Slightly longer than the 15-min cron interval to prevent expiry-at-fire races

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function getCachedSignals(source: string): Promise<SanitizedSignal[] | null> {
  const cached = await prisma.signalCache.findFirst({
    where:   { source, expiresAt: { gt: new Date() } },
    orderBy: { fetchedAt: 'desc' },
  });
  if (!cached) return null;
  // Rows cached before sanitisation existed are cleaned on the way out too.
  return (cached.payload as unknown as RawSignal[]).map(sanitizeSignal);
}

async function cacheSignals(source: string, signals: SanitizedSignal[]): Promise<void> {
  // Delete all expired rows for this source before inserting the fresh one
  // to prevent unbounded DB growth over time.
  await prisma.signalCache.deleteMany({
    where: { source, expiresAt: { lte: new Date() } },
  }).catch(() => {});  // non-fatal — just a cleanup step

  await prisma.signalCache.create({
    data: {
      source,
      payload:   signals as any,
      expiresAt: dayjs().add(CACHE_TTL_MINUTES, 'minute').toDate(),
    },
  });
}

// ─── NewsAPI ──────────────────────────────────────────────────────────────────

/**
 * Fetches financial, political, sports, and entertainment signals from NewsAPI.
 * Results are cached for 15 minutes (matches cron interval).
 */
export async function fetchNewsSignals(signal?: AbortSignal): Promise<SanitizedSignal[]> {
  const cached = await getCachedSignals('NEWSAPI');
  if (cached) {
    logger.debug('Using cached NewsAPI signals');
    return cached;
  }

  const newsApiKey = secret('NEWSAPI_KEY');
  if (!newsApiKey) {
    logger.warn('NEWSAPI_KEY not set — skipping news ingestion');
    return [];
  }

  return bulkheads.datasource.run(async () => {
    try {
      const { data } = await axios.get<{ articles: any[] }>(
        'https://newsapi.org/v2/everything',
        {
          params: {
            q: [
              'Federal Reserve OR ECB OR inflation OR "interest rates" OR GDP',
              'election OR parliament OR "political vote" OR president OR senate',
              'geopolitical OR sanctions OR treaty OR conflict',
              'bitcoin OR ethereum OR crypto OR "DeFi"',
              '"championship" OR "World Cup" OR "NBA Finals" OR "Super Bowl" OR "Premier League"',
              'Oscar OR Grammy OR Emmy OR "box office" OR "Billboard chart"',
            ].join(' OR '),
            language: 'en',
            sortBy:   'publishedAt',
            pageSize: 30,
            apiKey:   newsApiKey,
          },
          timeout: config.TIMEOUT_DATASOURCE_MS,
          signal,
        },
      );

      // Article text is attacker-controllable: sanitise before it is cached or used.
      const signals: SanitizedSignal[] = (data.articles ?? []).map((article: any) => sanitizeSignal({
        source:         'NEWSAPI',
        title:          article.title ?? '',
        content:        article.description ?? article.content ?? '',
        publishedAt:    article.publishedAt ?? new Date().toISOString(),
        relevanceScore: 0.7,
        category:       classifyNewsCategory(article.title ?? ''),
        ...(typeof article.url === 'string' ? { url: article.url } : {}),
      }));

      await cacheSignals('NEWSAPI', signals);
      logger.info({ count: signals.length }, 'Fetched news signals');
      return signals;
    } catch (err: any) {
      if (signal?.aborted) throw signal.reason;
      logger.error({ err: err?.message }, 'Failed to fetch NewsAPI signals');
      return [];
    }
  }, signal);
}

// ─── FRED API ─────────────────────────────────────────────────────────────────

/**
 * Fetches Federal Reserve economic data from FRED.
 * Series: FEDFUNDS, CPIAUCSL, UNRATE, T10Y2Y
 * Series are fetched concurrently through bulkheads.datasource.
 */
export async function fetchFedData(signal?: AbortSignal): Promise<SanitizedSignal[]> {
  const cached = await getCachedSignals('FRED');
  if (cached) return cached;

  const series = ['FEDFUNDS', 'CPIAUCSL', 'UNRATE', 'T10Y2Y'];
  const results = await Promise.allSettled(
    series.map((seriesId) =>
      bulkheads.datasource.run(async () => {
        const fredApiKey = secret('FRED_API_KEY');
        const apiKeyParam = fredApiKey ? `&api_key=${fredApiKey}` : '';
        const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&file_type=json&sort_order=desc&limit=2${apiKeyParam}`;

        const { data } = await axios.get<{ observations: any[] }>(url, {
          timeout: config.TIMEOUT_DATASOURCE_MS,
          signal,
        });
        const observations = data.observations ?? [];

        if (observations.length > 0) {
          const latest   = observations[0];
          const previous = observations[1];
          const change   = previous ? parseFloat(latest.value) - parseFloat(previous.value) : 0;

          return {
            source:         'FRED' as const,
            title:          `${seriesId}: ${latest.value}`,
            content:        `${seriesId} = ${latest.value} (${change >= 0 ? '+' : ''}${change.toFixed(3)} vs prior). Date: ${latest.date}`,
            publishedAt:    new Date(latest.date).toISOString(),
            relevanceScore: 0.9,
            category:       'FED',
          };
        }
        return null;
      }, signal),
    ),
  );

  const signals: SanitizedSignal[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      signals.push(sanitizeSignal(r.value));
    }
  }

  if (signals.length > 0) await cacheSignals('FRED', signals);
  logger.info({ count: signals.length }, 'Fetched FRED signals');
  return signals;
}

// ─── GDELT API ────────────────────────────────────────────────────────────────

const GDELT_TIMEOUT_MS = 8_000;

export async function fetchMacroEvents(signal?: AbortSignal): Promise<SanitizedSignal[]> {
  const cached = await getCachedSignals('GDELT');
  if (cached) {
    logger.debug('Using cached GDELT signals');
    return cached;
  }

  const handle = deadline('datasource', signal, GDELT_TIMEOUT_MS);

  try {
    return await bulkheads.datasource.run(async () => {
      try {
        const { data } = await axios.get(
          'https://api.gdeltproject.org/api/v2/doc/doc',
          {
            params: {
              query:      '"central bank" OR "interest rate" OR inflation OR election OR geopolitical',
              mode:       'artlist',
              format:     'json',
              maxrecords: 10,
              timespan:   '1440',
            },
            timeout: GDELT_TIMEOUT_MS,
            signal: handle.signal,
          },
        );

        const articles: any[] = data?.articles ?? [];
        // The article URL is kept in `url`, not in the text the model sees.
        const signals: SanitizedSignal[] = articles.map((a: any) => sanitizeSignal({
          source:         'GDELT',
          title:          a.title ?? '',
          content:        '',
          url:            typeof a.url === 'string' ? a.url : undefined,
          publishedAt:    a.seendate ?? new Date().toISOString(),
          relevanceScore: 0.6,
          category:       classifyNewsCategory(a.title ?? ''),
        }));

        if (signals.length > 0) {
          await cacheSignals('GDELT', signals);
          logger.info({ count: signals.length }, 'Fetched GDELT signals');
        }
        return signals;
      } catch (err: any) {
        const isTimeout =
          handle.signal.aborted ||
          err?.code === 'ECONNABORTED' ||
          err?.code === 'ERR_CANCELED' ||
          err?.message?.includes('aborted');

        if (isTimeout) {
          logger.debug('GDELT timed out — continuing without macro signals this cycle');
        } else {
          logger.warn({ err: err?.message }, 'GDELT fetch failed — continuing without macro signals');
        }
        return [];
      }
    }, handle.signal);
  } finally {
    handle.cleanup?.();
  }
}

// ─── Aggregator ───────────────────────────────────────────────────────────────

/**
 * Aggregates all signal sources into a unified object.
 *
 * All three fetches run in parallel via Promise.allSettled so one slow
 * source never blocks the others. GDELT is the most likely to fail; the
 * market maker cycle proceeds normally with news + FRED alone.
 */
export async function aggregateSignals(signal?: AbortSignal): Promise<AggregatedSignals> {
  const [newsRaw, fedRaw, macroRaw] = await Promise.allSettled([
    fetchNewsSignals(signal),
    fetchFedData(signal),
    fetchMacroEvents(signal),
  ]);

  const news  = newsRaw.status  === 'fulfilled' ? newsRaw.value  : [];
  const fed   = fedRaw.status   === 'fulfilled' ? fedRaw.value   : [];
  const macro = macroRaw.status === 'fulfilled' ? macroRaw.value : [];

  const total = news.length + fed.length + macro.length;
  logger.info({ news: news.length, fed: fed.length, macro: macro.length }, 'Signals aggregated');

  return { news, fed, macro, aggregatedAt: new Date(), signalCount: total };
}

// ─── Category classifier ──────────────────────────────────────────────────────

function classifyNewsCategory(title: string): string {
  const t = title.toLowerCase();

  if (t.includes('federal reserve') || t.includes('fed ') || t.includes('fomc') || t.includes('fed rate'))
    return 'FED';
  if (t.includes('ecb') || t.includes('european central bank') || t.includes('lagarde'))
    return 'ECB';
  if (t.includes('election') || t.includes('senate') || t.includes('president') || t.includes('parliament') || t.includes('vote'))
    return 'ELECTION';
  if (t.includes('sanctions') || t.includes('treaty') || t.includes('conflict') || t.includes('geopolitical') || t.includes('war'))
    return 'GEOPOLITICAL';
  if (t.includes('bitcoin') || t.includes('ethereum') || t.includes('crypto') || t.includes('defi'))
    return 'CRYPTO';
  if (t.includes('nba') || t.includes('world cup') || t.includes('super bowl') || t.includes('premier league') || t.includes('championship'))
    return 'SPORTS';
  if (t.includes('oscar') || t.includes('grammy') || t.includes('emmy') || t.includes('box office') || t.includes('billboard'))
    return 'ENTERTAINMENT';
  return 'MACRO';
}