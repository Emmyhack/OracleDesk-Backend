/**
 * The trader's independent probability model (#75).
 *
 * Two forecasters behind one interface, combined into an ensemble:
 *
 *   llmForecaster       base rate, then per-signal adjustments, then p and a
 *                       50% interval, from the question, the verified question
 *                       document and the relevant signals. It is never shown the
 *                       market price, the opening price or the creator's
 *                       interval (ForecastInput has no such fields).
 *   baseRateForecaster  a reviewed table of reference-class frequencies
 *                       (forecast.base-rates.json); unknown questions get the
 *                       uninformative p = 0.5, σ = 0.25.
 *
 * ensemble() combines them in log-odds space with inverse-variance weights,
 * shrinks toward 0.5 and returns a 90% interval. The trader's edge, Kelly
 * input and trace come from that, never from the price it trades against.
 *
 * Residual risk: an LLM can still infer a price from news text ("traders see
 * 70% odds"). The prompt tells it to ignore quoted odds, rationales must cite
 * signal ids, and the per-signal adjustments are recorded in the trace so such
 * anchoring is visible after the fact.
 */
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../lib/logger';
import { getRedis } from '../lib/redis';
import { now as clockNow } from '../lib/clock';
import { callLLMStructured } from '../lib/llm';
import { LlmBudgetExceeded } from '../lib/llm-budget';
import { defineStructured } from '../lib/llm-schema';
import { forecastV1 } from '../lib/prompts';
import { canonicalJson, sha256Hex, verifyTraceHash } from '../utils/hash.util';
import { fetchIpfsBytes } from './ipfs.service';
import { meaningfulTokens, tokenOverlap } from './market-policy';
import { partitionSignals, renderUntrustedBlock, renderUntrustedRecord, sanitizeSignal, sanitizeSignalText } from './llm-guard.service';
import baseRateTable from './forecast.base-rates.json';
import type {
  AggregatedSignal,
  AggregatedSignals,
  EnsembleForecast,
  ForecastInput,
  Forecaster,
  ModelForecast,
} from '../types';

// ─── Numerics ─────────────────────────────────────────────────────────────────

export const P_MIN = 0.02;
export const P_MAX = 0.98;
/** No member may claim more certainty than this (probability units). */
export const SIGMA_FLOOR = 0.05;
/** Interquartile range of a standard normal: a 50% interval is ±0.6745σ. */
export const NORMAL_IQR = 1.349;
/** Two-sided 90% normal quantile. */
export const Z90 = 1.6448536269514722;
const CI_MIN = 0.001;
const CI_MAX = 0.999;

export const clampP = (p: number): number => Math.min(P_MAX, Math.max(P_MIN, p));
export const logit = (p: number): number => {
  const q = clampP(p);
  return Math.log(q / (1 - q));
};
export const logistic = (x: number): number => 1 / (1 + Math.exp(-x));

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Inverse-variance combination in log-odds, then shrinkage toward 0.5.
 *
 * Each member's σ (probability units, floored at SIGMA_FLOOR so no member can
 * dominate by claiming certainty) is mapped to log-odds by the delta method,
 * s = σ / (p(1−p)), and weighted w ∝ 1/s²; the pooled variance is 1/Σ(1/s²).
 * The mean is multiplied by (1 − shrink) — a hedge against overconfidence —
 * and ci = logistic(μ ± 1.645·σ) is a 90% interval that contains p.
 * (Disagreement between LLM samples is already in the LLM member's σ.)
 */
export function ensemble(
  members: ModelForecast[],
  shrink: number = config.FORECAST_SHRINK,
  inputsDigest = '',
): EnsembleForecast {
  if (members.length === 0) throw new Error('ensemble needs at least one member');
  const prepared = members.map((m) => {
    const p = clampP(m.p);
    const sigma = Math.max(SIGMA_FLOOR, m.sigma);
    const s = sigma / (p * (1 - p));
    return { m: { ...m, p, sigma }, mu: logit(p), invVar: 1 / (s * s) };
  });
  const total = prepared.reduce((acc, x) => acc + x.invVar, 0);
  const mu = prepared.reduce((acc, x) => acc + x.invVar * x.mu, 0) / total;
  const sigmaLogit = Math.sqrt(1 / total);
  const shrunk = (1 - shrink) * mu;
  const p = clampP(logistic(shrunk));
  return {
    p: round(p),
    // Kept inside (0, 1) after rounding, so 1 − upper and lower are usable probabilities.
    ci: {
      lower: Math.max(CI_MIN, round(Math.min(p, logistic(shrunk - Z90 * sigmaLogit)))),
      upper: Math.min(CI_MAX, round(Math.max(p, logistic(shrunk + Z90 * sigmaLogit)))),
    },
    sigmaLogit: round(sigmaLogit),
    shrink,
    members: prepared.map((x) => ({ ...x.m, p: round(x.m.p), sigma: round(x.m.sigma), weight: round(x.invVar / total) })),
    inputsDigest,
  };
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** The slice of a market a forecast reads. No price fields, by design. */
export interface ForecastMarket {
  id: string;
  question: string;
  category: string;
  expiryTimestamp: Date;
  resolutionOracle?: string | null;
  metaUri?: string | null;
  questionHash?: string | null;
}

export const MAX_RELEVANT_SIGNALS = 8;

/**
 * Signals that bear on the question: those sharing meaningful tokens with it
 * (the dedup tokeniser), or of the market's category. Ranked by overlap,
 * then category match, then the aggregator's relevance. At most eight.
 */
export function relevantSignals(market: Pick<ForecastMarket, 'question' | 'category'>, agg: AggregatedSignals, max = MAX_RELEVANT_SIGNALS): AggregatedSignal[] {
  const questionTokens = new Set(meaningfulTokens(market.question));
  return [...agg.news, ...agg.fed, ...agg.macro]
    .map((s) => ({
      s,
      overlap: tokenOverlap([...new Set(meaningfulTokens(`${s.title} ${s.content}`))], questionTokens),
      sameCategory: s.category === market.category,
    }))
    .filter((x) => x.overlap > 0 || x.sameCategory)
    .sort((a, b) =>
      b.overlap - a.overlap
      || Number(b.sameCategory) - Number(a.sameCategory)
      || b.s.relevanceScore - a.s.relevanceScore
      || (a.s.signalId < b.s.signalId ? -1 : 1))
    .slice(0, max)
    .map((x) => x.s);
}

/** The only question-document fields a forecaster sees (the creator's interval is never among them). */
const QUESTION_DOC_FIELDS = ['question', 'category', 'closeTime', 'resolutionSource', 'resolution', 'priceResolution'] as const;

export type DocFetcher = (cid: string) => Promise<Buffer>;

/**
 * The pinned question document, used only when its bytes hash to the
 * market's questionHash. Anything else (no metaUri, fetch failure, hash
 * mismatch, unparseable JSON) forecasts without it.
 */
export async function loadQuestionDoc(
  market: Pick<ForecastMarket, 'id' | 'metaUri' | 'questionHash'>,
  fetchBytes: DocFetcher = (cid) => fetchIpfsBytes(cid),
): Promise<Record<string, unknown> | null> {
  const cid = market.metaUri?.startsWith('ipfs://') ? market.metaUri.slice('ipfs://'.length) : null;
  if (!cid || !market.questionHash) return null;
  let bytes: Buffer;
  try {
    bytes = await fetchBytes(cid);
  } catch (err) {
    logger.warn({ marketId: market.id, err: (err as Error)?.message }, 'FORECAST_DOC_UNAVAILABLE: forecasting without the question document');
    return null;
  }
  if (!verifyTraceHash(bytes, market.questionHash)) {
    logger.warn({ marketId: market.id, cid }, 'FORECAST_DOC_UNVERIFIED: question document does not match questionHash; ignored');
    return null;
  }
  try {
    const doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    return Object.fromEntries(QUESTION_DOC_FIELDS.filter((k) => doc[k] !== undefined).map((k) => [k, doc[k]]));
  } catch {
    return null;
  }
}

export function buildForecastInput(
  market: ForecastMarket,
  signals: AggregatedSignal[],
  questionDoc: Record<string, unknown> | null,
  now: Date,
): ForecastInput {
  return {
    marketId: market.id,
    question: market.question,
    category: market.category,
    closeTime: market.expiryTimestamp,
    resolutionSource: market.resolutionOracle ?? null,
    questionDoc,
    signals: signals.map((s) => ({ id: s.signalId, source: s.source, title: s.title, publishedAt: s.publishedAt })),
    now,
  };
}

/** Digest of what a forecast depends on; `now` is left out so it is stable across cycles. */
export function forecastInputDigest(input: ForecastInput): string {
  const { now: _now, ...rest } = input;
  return sha256Hex(canonicalJson({ ...rest, closeTime: rest.closeTime.toISOString() }));
}

// ─── LLM forecaster ───────────────────────────────────────────────────────────

const forecastSchema = z.object({
  base_rate: z.number().min(0).max(1),
  adjustments: z
    .array(z.object({ signal_id: z.string(), delta: z.number().min(-1).max(1), why: z.string().max(300) }))
    .max(16),
  p: z.number().min(0).max(1),
  p_low_50: z.number().min(0).max(1),
  p_high_50: z.number().min(0).max(1),
  rationale: z.string().min(10).max(1500),
});

export type LlmForecastOutput = z.infer<typeof forecastSchema>;

export const forecastSpec = defineStructured(
  'submit_forecast',
  'Submit a probability forecast: base rate, per-signal adjustments, final p and a 50% interval.',
  forecastSchema,
  (v) => (v.p_low_50 <= v.p && v.p <= v.p_high_50 ? null : 'p_low_50 <= p <= p_high_50 must hold'),
);

/** The rendered prompt and the signal ids it cites (s1…), for the trace and tests. */
export function buildForecastPrompt(input: ForecastInput): { system: string; user: string; citations: Record<string, string | undefined> } {
  const sanitized = input.signals.map((s, i) => ({
    ...sanitizeSignal({ source: s.source, title: s.title, content: '', publishedAt: s.publishedAt, relevanceScore: 0, category: '' }),
    id: `s${i + 1}`,
  }));
  const { clean } = partitionSignals(sanitized);
  const citations = Object.fromEntries(clean.map((s) => [s.id, input.signals[Number(s.id.slice(1)) - 1]?.id]));
  const doc = input.questionDoc ? renderUntrustedRecord(input.questionDoc, 'question_document', undefined, 600) : null;
  const daysToClose = Math.max(0, Math.round((input.closeTime.getTime() - input.now.getTime()) / 86_400_000));
  const { system, user } = forecastV1.render({
    now: input.now.toISOString(),
    question: sanitizeSignalText(input.question, 400).text,
    category: String(input.category),
    closeTime: input.closeTime.toISOString(),
    daysToClose,
    resolutionSource: input.resolutionSource ? sanitizeSignalText(input.resolutionSource, 80).text : 'unspecified',
    questionDocBlock: doc ? `QUESTION DOCUMENT (pinned, hash-verified):\n${doc}` : 'QUESTION DOCUMENT: none available.',
    signalsBlock: clean.length > 0 ? renderUntrustedBlock(clean, 'untrusted_signals') : '(no relevant signals)',
  });
  return { system, user, citations };
}

/** Per-cycle forecast budget (#75): markets forecast and LLM calls made. */
export class ForecastSession {
  marketsForecast = 0;
  llmCalls = 0;
  capLogged = false;

  constructor(
    readonly maxMarkets: number = config.FORECAST_MAX_MARKETS_PER_CYCLE,
    readonly maxLlmCalls: number = config.FORECAST_MAX_LLM_CALLS_PER_CYCLE,
  ) {}

  takeMarket(): boolean {
    if (this.marketsForecast >= this.maxMarkets) return false;
    this.marketsForecast++;
    return true;
  }

  takeLlmCall(): boolean {
    if (this.llmCalls >= this.maxLlmCalls) return false;
    this.llmCalls++;
    return true;
  }
}

/**
 * The LLM estimator. With FORECAST_LLM_SAMPLES > 1 it takes the median p and
 * adds the samples' spread to the variance; σ = (p_high_50 − p_low_50) / 1.349.
 * Returns null when no sample succeeded (budget, cap or provider failure).
 */
export function llmForecaster(session: ForecastSession, samples: number = config.FORECAST_LLM_SAMPLES): Forecaster {
  return {
    name: 'llm',
    async forecast(input) {
      const { system, user, citations } = buildForecastPrompt(input);
      const outputs: Array<{ value: LlmForecastOutput; model: string }> = [];
      for (let i = 0; i < samples; i++) {
        if (!session.takeLlmCall()) {
          logger.info({ marketId: input.marketId, llmCalls: session.llmCalls }, 'Forecast LLM call cap reached for this cycle');
          break;
        }
        try {
          const result = await callLLMStructured(forecastSpec, { system, user }, {
            maxTokens: 1500,
            ctx: { purpose: 'forecast', priority: 'cron' },
            task: 'forecasting',
            prompt: { id: forecastV1.id, version: forecastV1.version, hash: forecastV1.contentHash },
          });
          outputs.push({ value: result.value, model: `${result.provider}:${result.model}` });
        } catch (err) {
          if (err instanceof LlmBudgetExceeded) {
            logger.warn({ marketId: input.marketId }, 'LLM budget exhausted — no forecast');
            break;
          }
          logger.warn({ marketId: input.marketId, err: (err as Error)?.message?.slice(0, 200) }, 'Forecast LLM call failed');
        }
      }
      if (outputs.length === 0) return null;

      const ps = outputs.map((o) => clampP(o.value.p));
      const p = median(ps);
      const iqrSigma = median(outputs.map((o) => Math.max(0, o.value.p_high_50 - o.value.p_low_50) / NORMAL_IQR));
      const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
      const sampleVar = ps.length > 1 ? ps.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (ps.length - 1) : 0;
      const sigma = Math.max(SIGMA_FLOOR, Math.sqrt(iqrSigma ** 2 + sampleVar));
      const first = outputs[0].value;
      return {
        model: `llm:${outputs[0].model}`,
        p,
        sigma,
        rationale: first.rationale,
        inputsDigest: sha256Hex(canonicalJson({
          prompt: { id: forecastV1.id, version: forecastV1.version, hash: forecastV1.contentHash },
          input: forecastInputDigest(input),
        })),
        detail: {
          baseRate: first.base_rate,
          // Prompt ids (s1…) mapped back to signal-store ids.
          adjustments: first.adjustments.map((a) => ({ ...a, signalId: citations[a.signal_id] ?? null })),
          interval50: [first.p_low_50, first.p_high_50],
          samples: outputs.length,
          ...(outputs.length > 1 ? { sampleP: ps } : {}),
        },
      };
    },
  };
}

// ─── Base-rate forecaster ─────────────────────────────────────────────────────

interface BaseRateEntry {
  id: string;
  category: string | null;
  pattern: string;
  p: number;
  sigma: number;
  basis: string;
  source: string;
}

const BASE_RATES = (baseRateTable as { version: number; entries: BaseRateEntry[] });
const COMPILED = BASE_RATES.entries.map((e) => ({ ...e, re: new RegExp(e.pattern, 'i') }));
export const UNINFORMATIVE = { p: 0.5, sigma: 0.25 } as const;

export const baseRateForecaster: Forecaster = {
  name: 'base_rate',
  async forecast(input) {
    const entry = COMPILED.find((e) => (e.category === null || e.category === input.category) && e.re.test(input.question));
    const digest = sha256Hex(canonicalJson({ table: BASE_RATES.version, entry: entry?.id ?? null, question: input.question, category: input.category }));
    if (!entry) {
      return { model: `base_rate:v${BASE_RATES.version}`, ...UNINFORMATIVE, rationale: 'No matching reference class; uninformative prior.', inputsDigest: digest, detail: { entry: null } };
    }
    return {
      model: `base_rate:v${BASE_RATES.version}`,
      p: entry.p,
      sigma: entry.sigma,
      rationale: entry.basis,
      inputsDigest: digest,
      detail: { entry: entry.id, source: entry.source },
    };
  },
};

// ─── Cache ────────────────────────────────────────────────────────────────────

export interface ForecastCache {
  get(key: string): Promise<EnsembleForecast | null>;
  set(key: string, value: EnsembleForecast, ttlSeconds: number): Promise<void>;
  /** When the market was last forecast (any inputs), for ranking. */
  lastForecastAt(marketId: string): Promise<Date | null>;
  markForecast(marketId: string, at: Date, ttlSeconds: number): Promise<void>;
}

/** Redis-backed; a Redis failure is a cache miss, never an error. */
export const redisForecastCache: ForecastCache = {
  async get(key) {
    try {
      const raw = await getRedis().get(key);
      return raw ? (JSON.parse(raw) as EnsembleForecast) : null;
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'forecast cache read failed');
      return null;
    }
  },
  async set(key, value, ttl) {
    await getRedis().set(key, JSON.stringify(value), 'EX', Math.ceil(ttl)).catch((err) =>
      logger.warn({ err: (err as Error)?.message }, 'forecast cache write failed'));
  },
  async lastForecastAt(marketId) {
    try {
      const raw = await getRedis().get(`forecast:last:${marketId}`);
      return raw ? new Date(raw) : null;
    } catch {
      return null;
    }
  },
  async markForecast(marketId, at, ttl) {
    await getRedis().set(`forecast:last:${marketId}`, at.toISOString(), 'EX', Math.ceil(ttl)).catch(() => undefined);
  },
};

export class MemoryForecastCache implements ForecastCache {
  readonly entries = new Map<string, EnsembleForecast>();
  readonly last = new Map<string, Date>();
  async get(key: string) { return this.entries.get(key) ?? null; }
  async set(key: string, value: EnsembleForecast) { this.entries.set(key, value); }
  async lastForecastAt(marketId: string) { return this.last.get(marketId) ?? null; }
  async markForecast(marketId: string, at: Date) { this.last.set(marketId, at); }
}

let cache: ForecastCache = redisForecastCache;

/** Test seam. Pass null to restore Redis. Returns the previous cache. */
export function setForecastCache(next: ForecastCache | null): ForecastCache {
  const prev = cache;
  cache = next ?? redisForecastCache;
  return prev;
}

/** forecast:{marketId}:{signalsDigest} — the question hash and the relevant signals. */
export function forecastCacheKey(market: Pick<ForecastMarket, 'id' | 'question' | 'questionHash'>, signals: AggregatedSignal[]): string {
  const digest = sha256Hex(canonicalJson({
    questionHash: market.questionHash ?? sha256Hex(market.question),
    signals: signals.map((s) => [s.signalId, s.title]),
  }));
  return `forecast:${market.id}:${digest}`;
}

/** Markets never or not recently forecast first, then by time to close. */
export async function rankForForecast<T extends { id: string; expiryTimestamp: Date }>(markets: T[], c: ForecastCache = cache): Promise<T[]> {
  const last = await Promise.all(markets.map((m) => c.lastForecastAt(m.id)));
  return markets
    .map((m, i) => ({ m, recent: last[i] !== null }))
    .sort((a, b) => Number(a.recent) - Number(b.recent) || a.m.expiryTimestamp.getTime() - b.m.expiryTimestamp.getTime())
    .map((x) => x.m);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export interface MarketForecast {
  forecast: EnsembleForecast;
  /** The signals the forecast was given, for the trace's sourcesUsed. */
  relevant: AggregatedSignal[];
  cached: boolean;
}

/**
 * Forecasts one market: relevant signals, a cache lookup keyed by the
 * question and those signals, then (within the session's caps) the verified
 * question document, both forecasters and the ensemble. Returns null when the
 * per-cycle cap is reached or the LLM produced nothing: a base rate alone is
 * not traded on.
 */
export async function forecastMarket(
  market: ForecastMarket,
  agg: AggregatedSignals,
  session: ForecastSession,
  deps: { forecasters?: Forecaster[]; cache?: ForecastCache; fetchDoc?: DocFetcher; now?: Date } = {},
): Promise<MarketForecast | null> {
  const c = deps.cache ?? cache;
  const relevant = relevantSignals(market, agg);
  const key = forecastCacheKey(market, relevant);
  const hit = await c.get(key);
  if (hit) return { forecast: hit, relevant, cached: true };

  if (!session.takeMarket()) {
    if (!session.capLogged) {
      session.capLogged = true;
      logger.info({ maxMarkets: session.maxMarkets }, 'FORECAST_CAP_REACHED: no more markets forecast this cycle');
    }
    return null;
  }

  const now = deps.now ?? clockNow();
  const questionDoc = await loadQuestionDoc(market, deps.fetchDoc);
  const input = buildForecastInput(market, relevant, questionDoc, now);
  const forecasters = deps.forecasters ?? [llmForecaster(session), baseRateForecaster];
  const results = await Promise.all(forecasters.map((f) => f.forecast(input).catch((err) => {
    logger.warn({ forecaster: f.name, marketId: market.id, err: (err as Error)?.message }, 'Forecaster failed');
    return null;
  })));
  const members = results.filter((m): m is ModelForecast => m !== null);
  if (!members.some((m) => m.model.startsWith('llm:'))) {
    logger.info({ marketId: market.id }, 'No LLM forecast this cycle — market not traded');
    return null;
  }

  const forecast = ensemble(members, config.FORECAST_SHRINK, forecastInputDigest(input));
  const ttl = config.FORECAST_CACHE_TTL_HOURS * 3600;
  await c.set(key, forecast, ttl);
  await c.markForecast(market.id, now, ttl);
  return { forecast, relevant, cached: false };
}
