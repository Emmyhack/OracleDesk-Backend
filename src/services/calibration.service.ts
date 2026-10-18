/**
 * Calibration of agent probabilities against resolved outcomes (#68).
 *
 * Are the agents' probabilities calibrated? When an agent says 70 %, does YES
 * happen about 70 % of the time? This joins resolved markets with the traces
 * that preceded resolution and computes Brier score, log loss, reliability
 * buckets (Wilson intervals), the Murphy decomposition and the market's own
 * Brier as a baseline, per slice. Daily snapshots are stored in
 * calibration_snapshots and served by GET /agents/calibration.
 *
 * Sampling rules:
 *   - voided markets (CANCELLED, null outcome) are excluded: counting them as
 *     NO would bias every figure;
 *   - only traces created strictly before resolvedAt: a later trace leaks the
 *     outcome;
 *   - only markets with onChainMarketId, i.e. resolved through the indexer;
 *     legacy rows resolved by other means are ignored;
 *   - each market has total weight 1 per slice, so a market with many trader
 *     traces cannot dominate. `weighting` picks how that weight is split
 *     between its traces: 'time' (default), 'last' or 'first'.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { wilson, type Interval } from '../lib/stats';

// ─── Pure metrics ────────────────────────────────────────────────────────────

export interface Sample {
  /** Predicted probability of YES. */
  p: number;
  /** Outcome: 1 = YES. */
  o: 0 | 1;
  /** Weight. */
  w: number;
  /** The market's own probability when the trace was written, if meaningful. */
  pm?: number;
}

const sumW = (s: Sample[]) => s.reduce((a, x) => a + x.w, 0);

/** Effective sample size (Σw)² / Σw². */
export function effectiveN(samples: Sample[]): number {
  const w = sumW(samples);
  const w2 = samples.reduce((a, x) => a + x.w * x.w, 0);
  return w2 === 0 ? 0 : (w * w) / w2;
}

/** Weighted mean of (p − o)². */
export function brier(samples: Sample[]): number {
  const w = sumW(samples);
  return w === 0 ? NaN : samples.reduce((a, x) => a + x.w * (x.p - x.o) ** 2, 0) / w;
}

export const LOG_LOSS_EPS = 1e-4;

/** Weighted log loss with p clipped to [eps, 1 − eps]. */
export function logLoss(samples: Sample[], eps = LOG_LOSS_EPS): number {
  const w = sumW(samples);
  if (w === 0) return NaN;
  const loss = samples.reduce((a, x) => {
    const p = Math.min(1 - eps, Math.max(eps, x.p));
    return a - x.w * (x.o === 1 ? Math.log(p) : Math.log(1 - p));
  }, 0);
  return loss / w;
}

/** How many samples were clipped by {@link logLoss}. */
export function clippedCount(samples: Sample[], eps = LOG_LOSS_EPS): number {
  return samples.filter((x) => x.p < eps || x.p > 1 - eps).length;
}

export interface Bucket {
  lower: number;
  upper: number;
  /** Total weight in the bucket. */
  count: number;
  /** Effective sample size of the bucket, used for the interval. */
  nEff: number;
  meanPredicted: number | null;
  observed: number | null;
  /** Wilson 95 % interval of the observed frequency at the bucket's effective n. */
  wilson95: Interval | null;
}

export type BinStrategy = 'equal' | 'quantile';

/** Splits samples into bins. Equal-width bins are [i/n, (i+1)/n), the last one closed. */
function assignBins(samples: Sample[], bins: number, strategy: BinStrategy): Sample[][] {
  const out: Sample[][] = Array.from({ length: bins }, () => []);
  if (strategy === 'equal') {
    for (const s of samples) out[Math.min(bins - 1, Math.max(0, Math.floor(s.p * bins)))].push(s);
    return out;
  }
  // quantile: equal total weight per bin, in order of p; equal p values stay together
  const sorted = [...samples].sort((a, b) => a.p - b.p);
  const total = sumW(sorted);
  let acc = 0;
  for (const s of sorted) {
    const idx = Math.min(bins - 1, Math.floor(((acc + s.w / 2) / total) * bins));
    out[idx].push(s);
    acc += s.w;
  }
  return out;
}

export function reliability(samples: Sample[], bins = 10, strategy: BinStrategy = 'equal'): Bucket[] {
  return assignBins(samples, bins, strategy).map((group, i) => {
    const edges = strategy === 'equal'
      ? { lower: i / bins, upper: (i + 1) / bins }
      : { lower: group.length ? Math.min(...group.map((s) => s.p)) : 0, upper: group.length ? Math.max(...group.map((s) => s.p)) : 0 };
    const w = sumW(group);
    if (w === 0) return { ...edges, count: 0, nEff: 0, meanPredicted: null, observed: null, wilson95: null };
    const observed = group.reduce((a, s) => a + s.w * s.o, 0) / w;
    const nEff = effectiveN(group);
    return {
      ...edges,
      count: w,
      nEff,
      meanPredicted: group.reduce((a, s) => a + s.w * s.p, 0) / w,
      observed,
      wilson95: wilson(observed * nEff, nEff),
    };
  });
}

export interface Murphy {
  /** Lower is better: how far predicted bin means sit from observed frequencies. */
  reliability: number;
  /** Higher is better: how far observed frequencies sit from the base rate. */
  resolution: number;
  /** Base-rate variance, ō(1 − ō); independent of the forecaster. */
  uncertainty: number;
}

/** Murphy (1973): Brier ≈ reliability − resolution + uncertainty (exact when p is constant per bin). */
export function murphy(samples: Sample[], bins = 10): Murphy {
  const w = sumW(samples);
  if (w === 0) return { reliability: NaN, resolution: NaN, uncertainty: NaN };
  const base = samples.reduce((a, s) => a + s.w * s.o, 0) / w;
  let rel = 0;
  let res = 0;
  for (const group of assignBins(samples, bins, 'equal')) {
    const gw = sumW(group);
    if (gw === 0) continue;
    const meanP = group.reduce((a, s) => a + s.w * s.p, 0) / gw;
    const obs = group.reduce((a, s) => a + s.w * s.o, 0) / gw;
    rel += (gw / w) * (meanP - obs) ** 2;
    res += (gw / w) * (obs - base) ** 2;
  }
  return { reliability: rel, resolution: res, uncertainty: base * (1 - base) };
}

export const SHRINKAGE_MIN = 0.3;
export const SHRINKAGE_MAX = 1;

/**
 * Least-squares shrinkage toward 0.5: p' = 0.5 + k (p − 0.5) minimises the
 * weighted Brier score at k = Σ w (p − .5)(o − .5) / Σ w (p − .5)², clamped to
 * [0.3, 1] (the factor only ever shrinks). `n` is the number of samples fitted.
 */
export function fitShrinkage(samples: Sample[]): { k: number; n: number } {
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += s.w * (s.p - 0.5) * (s.o - 0.5);
    den += s.w * (s.p - 0.5) ** 2;
  }
  if (den === 0) return { k: 1, n: samples.length };
  return { k: Math.min(SHRINKAGE_MAX, Math.max(SHRINKAGE_MIN, num / den)), n: samples.length };
}

/** p' = 0.5 + k (p − 0.5). */
export function applyShrinkage(p: number, k: number): number {
  return 0.5 + k * (p - 0.5);
}

// ─── Rows, weighting and slicing ─────────────────────────────────────────────

export type Weighting = 'time' | 'last' | 'first';
export const GROUP_BYS = ['agentType', 'category', 'decisionType', 'promptVersion', 'model', 'agentType_category'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const WINDOWS = ['30d', '90d', 'all'] as const;
export type Window = (typeof WINDOWS)[number];

/** One (trace, resolved market) pair as returned by {@link extractRows}. */
export interface TraceRow {
  marketId: string;
  agentType: string;
  decisionType: string;
  category: string;
  p: number;
  /** Market probability at trace time. */
  pm: number;
  createdAt: Date;
  resolvedAt: Date;
  /** 1 = YES, 0 = NO. */
  o: 0 | 1;
  /** `promptId@version` of the first provenance entry, or null (older traces). */
  promptVersion: string | null;
  /** Model of the first provenance entry, or null. */
  model: string | null;
}

/**
 * Turns the traces of one slice into weighted samples. Each market gets total
 * weight 1: 'time' weights a trace by how long its estimate was current
 * (until the next trace in the slice, or resolvedAt for the last one), 'last'
 * keeps only the final trace, 'first' only the first. Rows at or after
 * resolvedAt are dropped here too, so a caller cannot leak the outcome.
 */
export function buildSamples(rows: TraceRow[], weighting: Weighting = 'time'): Sample[] {
  const byMarket = new Map<string, TraceRow[]>();
  for (const r of rows) {
    if (r.createdAt.getTime() >= r.resolvedAt.getTime()) continue;
    const list = byMarket.get(r.marketId);
    if (list) list.push(r);
    else byMarket.set(r.marketId, [r]);
  }
  const out: Sample[] = [];
  for (const list of byMarket.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let weights: number[];
    if (weighting === 'last') weights = list.map((_, i) => (i === list.length - 1 ? 1 : 0));
    else if (weighting === 'first') weights = list.map((_, i) => (i === 0 ? 1 : 0));
    else {
      const spans = list.map((r, i) => (list[i + 1]?.createdAt ?? r.resolvedAt).getTime() - r.createdAt.getTime());
      const total = spans.reduce((a, b) => a + b, 0);
      weights = spans.map((s) => (total > 0 ? s / total : 1 / list.length));
    }
    list.forEach((r, i) => {
      if (weights[i] <= 0) return;
      out.push({
        p: r.p,
        o: r.o,
        w: weights[i],
        // The creation trace records 0.5 as a placeholder, not a market price.
        ...(r.decisionType === 'MARKET_CREATION' ? {} : { pm: r.pm }),
      });
    });
  }
  return out;
}

export function sliceKey(r: TraceRow, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'agentType': return r.agentType;
    case 'category': return r.category;
    case 'decisionType': return r.decisionType;
    case 'promptVersion': return r.promptVersion ?? 'unknown';
    case 'model': return r.model ?? 'unknown';
    case 'agentType_category': return `${r.agentType}:${r.category}`;
  }
}

export function sliceRows(rows: TraceRow[], groupBy: GroupBy): Map<string, TraceRow[]> {
  const out = new Map<string, TraceRow[]>();
  for (const r of rows) {
    const key = sliceKey(r, groupBy);
    const list = out.get(key);
    if (list) list.push(r);
    else out.set(key, [r]);
  }
  return out;
}

export interface SliceMetrics {
  insufficientData: boolean;
  nMarkets: number;
  nTraces: number;
  /** Effective sample size after weighting. */
  nEff: number;
  brier?: number;
  logLoss?: number;
  /** Samples whose probability was clipped for the log loss. */
  clipped?: number;
  buckets?: Bucket[];
  quantileBuckets?: Bucket[];
  murphy?: Murphy;
  /** The market's own Brier on the same traces; absent when no trace carries a market price. */
  baseline?: { brier: number; agentBrier: number; nTraces: number; meaningful: boolean; note: string } | null;
  /** Least-squares shrinkage, clamped to [0.3, 1]. Apply only when nMarkets ≥ the minimum for shrinkage. */
  shrinkageK?: number;
}

export interface MetricsOptions {
  weighting?: Weighting;
  minMarkets?: number;
}

export function computeSliceMetrics(rows: TraceRow[], opts: MetricsOptions = {}): SliceMetrics {
  const minMarkets = opts.minMarkets ?? config.MIN_CALIBRATION_MARKETS;
  const samples = buildSamples(rows, opts.weighting ?? config.CALIBRATION_WEIGHTING);
  const nMarkets = new Set(rows.filter((r) => r.createdAt < r.resolvedAt).map((r) => r.marketId)).size;
  const nTraces = rows.filter((r) => r.createdAt < r.resolvedAt).length;
  const nEff = effectiveN(samples);
  if (nMarkets < minMarkets) return { insufficientData: true, nMarkets, nTraces, nEff };

  const priced = samples.filter((s): s is Sample & { pm: number } => s.pm !== undefined);
  const baseline = priced.length === 0
    ? null
    : {
        brier: brier(priced.map((s) => ({ ...s, p: s.pm }))),
        agentBrier: brier(priced),
        nTraces: priced.length,
        meaningful: true,
        note: 'Market probability at trace time; MARKET_CREATION traces are excluded (their 0.5 is a placeholder).',
      };

  return {
    insufficientData: false,
    nMarkets,
    nTraces,
    nEff,
    brier: brier(samples),
    logLoss: logLoss(samples),
    clipped: clippedCount(samples),
    buckets: reliability(samples, 10, 'equal'),
    quantileBuckets: reliability(samples, 10, 'quantile'),
    murphy: murphy(samples, 10),
    baseline,
    shrinkageK: fitShrinkage(samples).k,
  };
}

// ─── Extraction (SQL) ────────────────────────────────────────────────────────

export function windowStart(window: Window, now = new Date()): Date | null {
  if (window === 'all') return null;
  const days = window === '30d' ? 30 : 90;
  return new Date(now.getTime() - days * 86_400_000);
}

type Db = Pick<typeof prisma, '$queryRaw'>;

interface RawRow {
  marketId: string;
  agentType: string;
  decisionType: string;
  category: string;
  p: number;
  pm: number;
  createdAt: Date;
  resolvedAt: Date;
  o: number;
  promptVersion: string | null;
  model: string | null;
}

/**
 * Resolved markets joined with the traces written strictly before resolution.
 * Postgres does the filtering; the first provenance entry supplies the prompt
 * version and model (null for traces that predate provenance).
 * `reasoning_traces ("marketId", "createdAt")` backs the join.
 */
export async function extractRows(db: Db, since: Date | null): Promise<TraceRow[]> {
  // An ISO string cast to timestamp keeps the UTC wall time that the
  // timestamp(3) columns store; a bound Date would be shifted by the session zone.
  const sinceIso = since ? since.toISOString() : null;
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT t."marketId"                               AS "marketId",
           t."agentType"::text                        AS "agentType",
           t."decisionType"                           AS "decisionType",
           m."category"::text                         AS "category",
           t."probabilityEstimate"                    AS "p",
           t."marketProbability"                      AS "pm",
           t."createdAt"                              AS "createdAt",
           m."resolvedAt"                             AS "resolvedAt",
           m."resolvedOutcome"::int                   AS "o",
           CASE WHEN t."provenance"->'llm'->0->>'promptId' IS NULL THEN NULL
                ELSE (t."provenance"->'llm'->0->>'promptId') || '@' || COALESCE(t."provenance"->'llm'->0->>'promptVersion', '?')
           END                                        AS "promptVersion",
           t."provenance"->'llm'->0->>'model'         AS "model"
    FROM reasoning_traces t
    JOIN markets m ON m.id = t."marketId"
    WHERE m.status = 'RESOLVED'
      AND m."resolvedOutcome" IS NOT NULL
      AND m."onChainMarketId" IS NOT NULL
      AND t."createdAt" < m."resolvedAt"
      AND (${sinceIso}::text IS NULL OR m."resolvedAt" >= ${sinceIso}::timestamp)
    ORDER BY t."marketId", t."createdAt"
  `);
  return rows.map((r) => ({ ...r, o: r.o === 1 ? 1 : 0 }));
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

/** Arbitrary but fixed: serialises snapshot runs across instances. */
const LOCK_NAME = 'oracledesk:calibration_snapshots';

export interface SnapshotRun {
  computedAt: Date;
  rows: number;
  windows: Window[];
  slices: number;
  insufficient: number;
}

/**
 * Computes every (window × groupBy × key) slice and stores it. Runs inside a
 * transaction holding a Postgres advisory lock, so when several instances fire
 * the cron only one does the work (the others return null).
 */
export async function computeAndStoreSnapshots(opts: { weighting?: Weighting; now?: Date } = {}): Promise<SnapshotRun | null> {
  const computedAt = opts.now ?? new Date();
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_NAME})::bigint) AS "locked"`;
      if (!locked) {
        logger.info('Calibration snapshots: another instance holds the lock; skipping');
        return null;
      }
      let rowsSeen = 0;
      let slices = 0;
      let insufficient = 0;
      const data: Prisma.CalibrationSnapshotCreateManyInput[] = [];
      for (const window of WINDOWS) {
        const rows = await extractRows(tx, windowStart(window, computedAt));
        rowsSeen += rows.length;
        for (const groupBy of GROUP_BYS) {
          for (const [groupKey, group] of sliceRows(rows, groupBy)) {
            const metrics = computeSliceMetrics(group, { weighting: opts.weighting });
            slices++;
            if (metrics.insufficientData) insufficient++;
            data.push({ computedAt, window, groupBy, groupKey, metrics: JSON.parse(JSON.stringify(metrics, nanToNull)) });
          }
        }
      }
      if (data.length > 0) await tx.calibrationSnapshot.createMany({ data });
      logger.info({ rows: rowsSeen, slices, insufficient }, 'Calibration snapshots stored');
      return { computedAt, rows: rowsSeen, windows: [...WINDOWS], slices, insufficient };
    },
    { timeout: 120_000, maxWait: 5_000 },
  );
}

/** JSON has no NaN/Infinity: store null instead of silently coercing. */
function nanToNull(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}

export interface SnapshotQuery {
  window: Window;
  groupBy: GroupBy;
  /** Exact slice key, e.g. "TRADER" or "TRADER:FED". */
  groupKey?: string;
}

/** Latest stored snapshot rows for a (window, groupBy), optionally one key. */
export async function latestSnapshots(q: SnapshotQuery) {
  const latest = await prisma.calibrationSnapshot.findFirst({
    where: { window: q.window, groupBy: q.groupBy },
    orderBy: { computedAt: 'desc' },
    select: { computedAt: true },
  });
  if (!latest) return { computedAt: null as Date | null, slices: [] as Array<{ groupKey: string; metrics: unknown }> };
  const rows = await prisma.calibrationSnapshot.findMany({
    where: { window: q.window, groupBy: q.groupBy, computedAt: latest.computedAt, ...(q.groupKey ? { groupKey: q.groupKey } : {}) },
    orderBy: { groupKey: 'asc' },
    select: { groupKey: true, metrics: true },
  });
  return { computedAt: latest.computedAt, slices: rows };
}

/** Enough resolved markets before a fitted factor other than 1 is applied. */
export const MIN_SHRINKAGE_MARKETS = 50;

/**
 * The calibration factor k for an agent's category: the latest 'all'-window
 * (agentType, category) slice, then the (agentType) slice, then 1. A fit is
 * used only when it rests on at least MIN_SHRINKAGE_MARKETS markets; with few
 * markets it would just fit noise. Always 1 unless CALIBRATION_SHRINKAGE_ENABLED.
 */
export async function calibrationShrinkage(
  agentType: string,
  category: string,
  deps: { enabled?: boolean; lookup?: typeof latestSnapshots } = {},
): Promise<{ k: number; source: 'agentType_category' | 'agentType' | 'none'; nMarkets: number }> {
  const none = { k: 1, source: 'none' as const, nMarkets: 0 };
  if (!(deps.enabled ?? config.CALIBRATION_SHRINKAGE_ENABLED)) return none;
  const lookup = deps.lookup ?? latestSnapshots;
  const candidates: Array<['agentType_category' | 'agentType', string]> = [
    ['agentType_category', `${agentType}:${category}`],
    ['agentType', agentType],
  ];
  for (const [groupBy, groupKey] of candidates) {
    const { slices } = await lookup({ window: 'all', groupBy, groupKey });
    const m = slices[0]?.metrics as SliceMetrics | undefined;
    if (m && !m.insufficientData && typeof m.shrinkageK === 'number' && m.nMarkets >= MIN_SHRINKAGE_MARKETS) {
      return { k: Math.min(SHRINKAGE_MAX, Math.max(SHRINKAGE_MIN, m.shrinkageK)), source: groupBy, nMarkets: m.nMarkets };
    }
  }
  return none;
}
