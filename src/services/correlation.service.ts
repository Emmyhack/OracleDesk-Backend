import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { withAdvisoryLock } from '../lib/advisory-lock';
import {
  activeIntervals,
  loadPriceSeries,
  resample,
  type PricePoint,
} from './price-history.service';
import { MAX_PROB_BPS, MIN_PROB_BPS } from '../generated/fpmm';
import type { CorrelationPair, CorrelationCheckResult } from '../types';

export const MAX_CORRELATED_EXPOSURE_PCT = 0.05;
export const CORRELATION_THRESHOLD       = 0.60;

/** Snapshots older than this are ignored and sizing falls back to the matrix. */
export const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SNAPSHOT_CACHE_MS = 5 * 60 * 1000;
const SNAPSHOTS_KEPT = 48;
const SNAPSHOT_MAX_MARKETS = 100;
const SNAPSHOT_EXPIRY_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const SNAPSHOT_LOCK = 'correlation-snapshot';

/**
 * Correlation matrix for all nine MarketCategory values.
 *
 * Values: -1 (perfect inverse) → 0 (no relationship) → +1 (perfect positive).
 *
 * New category reasoning:
 *   POLITICS ↔ ELECTION:     0.85 — political events directly drive electoral outcomes
 *   POLITICS ↔ GEOPOLITICAL: 0.65 — political decisions create geopolitical risk
 *   SPORTS ↔ SPORTS:         0.65 — sports events within a season correlate
 *   SPORTS ↔ ENTERTAINMENT:  0.20 — overlapping celebrity/media coverage
 *   ENTERTAINMENT:           Low correlation with financial markets (<0.15)
 */
export const CATEGORY_CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  FED: {
    FED: 0.90, MACRO: 0.75, ECB: 0.55, ELECTION: 0.20,
    GEOPOLITICAL: 0.15, CRYPTO: 0.30, POLITICS: 0.25,
    SPORTS: 0.05, ENTERTAINMENT: 0.05,
  },
  ECB: {
    ECB: 0.85, MACRO: 0.65, FED: 0.55, ELECTION: 0.20,
    GEOPOLITICAL: 0.25, CRYPTO: 0.20, POLITICS: 0.20,
    SPORTS: 0.05, ENTERTAINMENT: 0.05,
  },
  MACRO: {
    MACRO: 0.70, FED: 0.75, ECB: 0.65, ELECTION: 0.30,
    GEOPOLITICAL: 0.25, CRYPTO: 0.40, POLITICS: 0.35,
    SPORTS: 0.10, ENTERTAINMENT: 0.10,
  },
  ELECTION: {
    ELECTION: 0.60, GEOPOLITICAL: 0.50, POLITICS: 0.85,
    FED: 0.20, ECB: 0.20, MACRO: 0.30,
    CRYPTO: 0.10, SPORTS: 0.15, ENTERTAINMENT: 0.10,
  },
  GEOPOLITICAL: {
    GEOPOLITICAL: 0.55, ELECTION: 0.50, POLITICS: 0.65,
    MACRO: 0.25, FED: 0.15, ECB: 0.25,
    CRYPTO: 0.20, SPORTS: 0.10, ENTERTAINMENT: 0.05,
  },
  CRYPTO: {
    CRYPTO: 0.70, MACRO: 0.40, FED: 0.30, ECB: 0.20,
    ELECTION: 0.10, GEOPOLITICAL: 0.20, POLITICS: 0.15,
    SPORTS: 0.10, ENTERTAINMENT: 0.15,
  },
  POLITICS: {
    POLITICS: 0.80, ELECTION: 0.85, GEOPOLITICAL: 0.65,
    MACRO: 0.35, FED: 0.25, ECB: 0.20,
    CRYPTO: 0.15, SPORTS: 0.25, ENTERTAINMENT: 0.15,
  },
  SPORTS: {
    SPORTS: 0.65, ENTERTAINMENT: 0.20, POLITICS: 0.25,
    ELECTION: 0.15, MACRO: 0.10, GEOPOLITICAL: 0.10,
    FED: 0.05, ECB: 0.05, CRYPTO: 0.10,
  },
  ENTERTAINMENT: {
    ENTERTAINMENT: 0.55, SPORTS: 0.20, POLITICS: 0.15,
    ELECTION: 0.10, MACRO: 0.05, GEOPOLITICAL: 0.05,
    FED: 0.05, ECB: 0.05, CRYPTO: 0.15,
  },
};

/** Category-matrix prior for a pair of categories (0 when unknown). */
export function priorCorrelation(categoryA: string, categoryB: string): number {
  return CATEGORY_CORRELATION_MATRIX[categoryA]?.[categoryB] ?? 0;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function relationshipOf(rho: number): CorrelationPair['relationship'] {
  if (rho >= 0.05) return 'POSITIVE';
  if (rho <= -0.05) return 'NEGATIVE';
  return 'NONE';
}

// ─── Empirical estimator ──────────────────────────────────────────────────────

export interface MarketSeries {
  marketId: string;
  category: string;
  /** Resampled YES prices in bps on the common grid (null: no data). */
  levels: Array<number | null>;
  /** Per interval k (between grid k and k+1): did an external trade happen in it? */
  active: boolean[];
}

export interface EstimatorConfig {
  minOverlap: number;
  /** Pseudo-count κ of the shrinkage toward the prior. */
  kappa: number;
}

export interface PairEstimate {
  a: string;
  b: string;
  rho: number;
  /** Intervals where both markets were active. */
  n: number;
  method: 'empirical' | 'prior';
  sample: number | null;
  prior: number;
  delta: number;
}

const logit = (bps: number) => {
  // The contract clamps prices to [MIN_PROB_BPS, MAX_PROB_BPS].
  const p = clamp(bps, Number(MIN_PROB_BPS), Number(MAX_PROB_BPS)) / 10_000;
  return Math.log(p / (1 - p));
};

/** First differences of logit price per interval; null when the interval is inactive or a level is missing. */
export function logitReturns(levels: Array<number | null>, active: boolean[]): Array<number | null> {
  const out: Array<number | null> = [];
  for (let k = 1; k < levels.length; k++) {
    const prev = levels[k - 1];
    const cur = levels[k];
    out.push(active[k - 1] && prev !== null && cur !== null ? logit(cur) - logit(prev) : null);
  }
  return out;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  // Zero variance leaves the correlation undefined.
  if (sxx < 1e-12 || syy < 1e-12) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Pairwise-complete correlation of logit-price changes, shrunk toward the
 * category prior: ρ̂ = (1 − δ)·ρ_sample + δ·ρ_prior with δ = clamp(κ/(κ+n), 0.1, 1).
 *
 * This is a Ledoit–Wolf-inspired fixed-target shrinkage, not the full
 * Ledoit–Wolf optimal-intensity estimator: pairwise-complete samples differ in
 * size per pair, which breaks the assumptions behind the optimal intensity.
 * Few overlaps (or zero variance) lean on the prior; below `minOverlap` the
 * prior is used outright and `method` says so.
 */
export function estimatePair(x: MarketSeries, y: MarketSeries, cfg: EstimatorConfig): PairEstimate {
  const [a, b] = x.marketId < y.marketId ? [x, y] : [y, x];
  const prior = priorCorrelation(a.category, b.category);
  const ra = logitReturns(a.levels, a.active);
  const rb = logitReturns(b.levels, b.active);

  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < Math.min(ra.length, rb.length); k++) {
    const u = ra[k];
    const v = rb[k];
    if (u !== null && v !== null) {
      xs.push(u);
      ys.push(v);
    }
  }
  const n = xs.length;
  const sample = n >= cfg.minOverlap ? pearson(xs, ys) : null;
  if (sample === null) {
    return { a: a.marketId, b: b.marketId, rho: prior, n, method: 'prior', sample: null, prior, delta: 1 };
  }
  const delta = clamp(cfg.kappa / (cfg.kappa + n), 0.1, 1);
  const rho = clamp((1 - delta) * sample + delta * prior, -1, 1);
  return { a: a.marketId, b: b.marketId, rho, n, method: 'empirical', sample, prior, delta };
}

export function estimateAllPairs(series: MarketSeries[], cfg: EstimatorConfig): PairEstimate[] {
  const sorted = [...series].sort((p, q) => (p.marketId < q.marketId ? -1 : 1));
  const out: PairEstimate[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) out.push(estimatePair(sorted[i], sorted[j], cfg));
  }
  return out;
}

// ─── Nearest PSD matrix ───────────────────────────────────────────────────────

/** Cyclic Jacobi eigen-solver for a small symmetric matrix. */
export function jacobiEigen(input: number[][], maxSweeps = 100, tol = 1e-14): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a: number[][] = input.map((r) => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

/**
 * Projects a symmetric matrix with unit diagonal onto the correlation
 * matrices by clipping negative eigenvalues and rescaling the diagonal to 1.
 * Pairwise estimates need not be PSD; this is only for the reported matrix,
 * sizing keeps the raw pairwise values. Intended for n ≤ 50.
 */
export function nearestPsdCorrelation(matrix: number[][]): number[][] {
  const n = matrix.length;
  if (n === 0) return [];
  const sym = matrix.map((row, i) => row.map((_, j) => (matrix[i][j] + matrix[j][i]) / 2));
  const { values, vectors } = jacobiEigen(sym);
  const floor = 1e-9;
  const clipped = values.map((l) => Math.max(l, floor));
  const b = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += vectors[i][k] * clipped[k] * vectors[j][k];
      b[i][j] = sum;
    }
  }
  const d = b.map((row, i) => Math.sqrt(row[i]));
  return b.map((row, i) => row.map((x, j) => (i === j ? 1 : clamp(x / (d[i] * d[j]), -1, 1))));
}

// ─── Snapshot computation ─────────────────────────────────────────────────────

export interface SnapshotPair extends PairEstimate {}

export interface ScopeMarket {
  id: string;
  category: string;
  onChainMarketId: bigint | null;
}

export type SeriesLoader = (onChainMarketId: bigint, since: Date) => Promise<PricePoint[]>;

/** Series on the grid ending at `now` for each market, then all pairwise estimates. */
export async function estimateSnapshotPairs(
  markets: ScopeMarket[],
  now: Date,
  cfg: EstimatorConfig & { gridSecs: number; windowDays: number },
  load: SeriesLoader = loadPriceSeries,
): Promise<SnapshotPair[]> {
  const end = Math.floor(now.getTime() / 1000 / cfg.gridSecs) * cfg.gridSecs;
  const start = end - cfg.windowDays * 24 * 60 * 60;
  const since = new Date(start * 1000);

  const series: MarketSeries[] = [];
  for (const m of markets) {
    const points = m.onChainMarketId === null ? [] : await load(m.onChainMarketId, since);
    series.push({
      marketId: m.id,
      category: m.category,
      levels: resample(points, start, end, cfg.gridSecs),
      active: activeIntervals(points, start, end, cfg.gridSecs),
    });
  }
  return estimateAllPairs(series, cfg);
}

/** The trader's universe: markets with open positions plus ACTIVE markets expiring within 14 days (≤ 100). */
async function snapshotScope(now: Date): Promise<ScopeMarket[]> {
  const select = { id: true, category: true, onChainMarketId: true } as const;
  const held = await prisma.market.findMany({ where: { positions: { some: { status: 'OPEN' } } }, select, take: SNAPSHOT_MAX_MARKETS });
  const room = SNAPSHOT_MAX_MARKETS - held.length;
  const upcoming = room > 0
    ? await prisma.market.findMany({
        where: {
          status: 'ACTIVE',
          id: { notIn: held.map((m) => m.id) },
          expiryTimestamp: { gt: now, lte: new Date(now.getTime() + SNAPSHOT_EXPIRY_HORIZON_MS) },
        },
        orderBy: { expiryTimestamp: 'asc' },
        select,
        take: room,
      })
    : [];
  return [...held, ...upcoming];
}

let snapshotRunning = false;

/**
 * Recomputes and stores a CorrelationSnapshot, then keeps the newest 48.
 * Never called from the trading path; scheduled by the monitor cron. One
 * instance computes at a time (in-process flag + Postgres advisory lock).
 */
export async function computeCorrelationSnapshot(now: Date = new Date()): Promise<{ id: string; pairs: number } | null> {
  if (snapshotRunning) return null;
  snapshotRunning = true;
  try {
    const result = await withAdvisoryLock(SNAPSHOT_LOCK, async () => {
      const markets = await snapshotScope(now);
      const pairs = await estimateSnapshotPairs(markets, now, {
        minOverlap: config.CORRELATION_MIN_OVERLAP,
        kappa: config.CORRELATION_PRIOR_KAPPA,
        gridSecs: config.CORRELATION_GRID_SECS,
        windowDays: config.CORRELATION_WINDOW_DAYS,
      });
      const row = await prisma.correlationSnapshot.create({
        data: {
          computedAt: now,
          gridStepSecs: config.CORRELATION_GRID_SECS,
          windowDays: config.CORRELATION_WINDOW_DAYS,
          pairs: pairs.map((p) => ({ a: p.a, b: p.b, rho: p.rho, n: p.n, method: p.method, sample: p.sample, prior: p.prior, delta: p.delta })),
        },
        select: { id: true },
      });
      const old = await prisma.correlationSnapshot.findMany({
        orderBy: { computedAt: 'desc' },
        skip: SNAPSHOTS_KEPT,
        select: { id: true },
      });
      if (old.length > 0) await prisma.correlationSnapshot.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
      logger.info({ snapshotId: row.id, markets: markets.length, pairs: pairs.length }, 'Correlation snapshot computed');
      return { id: row.id, pairs: pairs.length };
    });
    if (!result.acquired) {
      logger.debug('Correlation snapshot: another instance holds the lock — skipping');
      return null;
    }
    resetSnapshotCache();
    return result.value;
  } finally {
    snapshotRunning = false;
  }
}

// ─── Snapshot reads (cached) ──────────────────────────────────────────────────

export interface LoadedSnapshot {
  id: string;
  computedAt: Date;
  pairs: Map<string, SnapshotPair>;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

let cache: { loadedAt: number; snapshot: LoadedSnapshot | null } | null = null;

export function resetSnapshotCache(): void {
  cache = null;
}

/**
 * The latest snapshot, cached in memory for five minutes. A snapshot older
 * than two hours counts as missing (CORRELATION_SNAPSHOT_STALE is logged once
 * per refresh) so sizing falls back to the category matrix.
 */
export async function loadLatestSnapshot(now: Date = new Date()): Promise<LoadedSnapshot | null> {
  if (cache && now.getTime() - cache.loadedAt < SNAPSHOT_CACHE_MS) return cache.snapshot;

  let snapshot: LoadedSnapshot | null = null;
  try {
    const row = await prisma.correlationSnapshot.findFirst({ orderBy: { computedAt: 'desc' } });
    if (row) {
      if (now.getTime() - row.computedAt.getTime() > SNAPSHOT_MAX_AGE_MS) {
        logger.warn({ snapshotId: row.id, computedAt: row.computedAt }, 'CORRELATION_SNAPSHOT_STALE: falling back to the category matrix');
      } else {
        const pairs = new Map<string, SnapshotPair>();
        for (const p of row.pairs as unknown as SnapshotPair[]) pairs.set(pairKey(p.a, p.b), p);
        snapshot = { id: row.id, computedAt: row.computedAt, pairs };
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Correlation snapshot read failed; using the category matrix');
  }
  cache = { loadedAt: now.getTime(), snapshot };
  return snapshot;
}

// ─── Sizing ───────────────────────────────────────────────────────────────────

export type Direction = 'YES' | 'NO';

export interface ExposurePosition {
  marketId: string;
  category: string;
  direction: Direction;
  size: number;
}

/** Correlation for one pair: the snapshot's value when it has the pair, otherwise the matrix. */
export function pairCorrelation(
  a: { id: string; category: string },
  b: { id: string; category: string },
  snapshot: LoadedSnapshot | null,
): { rho: number; method: 'empirical' | 'prior' | 'matrix' } {
  const hit = snapshot?.pairs.get(pairKey(a.id, b.id));
  if (hit) return { rho: hit.rho, method: hit.method };
  return { rho: priorCorrelation(a.category, b.category), method: 'matrix' };
}

/**
 * Pure sizing core. A pair counts when |ρ| ≥ CORRELATION_THRESHOLD and
 * contributes ρ_eff × size, where ρ_eff = ρ if both holdings are on the same
 * side (YES/YES or NO/NO) and −ρ if they are on opposite sides. The four cases:
 *
 *   ρ ≥ +threshold, same side      → risk:  both lose together, adds ρ × size
 *   ρ ≥ +threshold, opposite sides → hedge: one pays when the other loses, subtracts ρ × size
 *   ρ ≤ −threshold, same side      → hedge: YES+YES on complements, subtracts |ρ| × size
 *   ρ ≤ −threshold, opposite sides → risk:  adds |ρ| × size
 *
 * Net correlated exposure never goes below zero. With no direction for the
 * proposed trade only the risk cases (ρ ≥ +threshold) count and no hedge credit
 * is given. Pairs below the threshold are ignored.
 */
export function evaluateCorrelation(input: {
  proposed: { marketId: string; category: string; direction?: Direction };
  proposedSize: number;
  bankroll: number;
  positions: ExposurePosition[];
  snapshot: LoadedSnapshot | null;
}): CorrelationCheckResult {
  const { proposed, proposedSize, bankroll, positions, snapshot } = input;
  const pairs: CorrelationPair[] = [];
  let net = 0;
  let usedSnapshot = false;

  for (const position of positions) {
    if (position.marketId === proposed.marketId) continue;
    const { rho, method } = pairCorrelation(
      { id: proposed.marketId, category: proposed.category },
      { id: position.marketId, category: position.category },
      snapshot,
    );
    if (method !== 'matrix') usedSnapshot = true;
    if (Math.abs(rho) < CORRELATION_THRESHOLD) continue;

    let effective: number;
    if (proposed.direction === undefined) {
      if (rho < 0) continue;
      effective = rho;
    } else {
      effective = proposed.direction === position.direction ? rho : -rho;
    }
    net += effective * position.size;
    pairs.push({
      marketIdA: proposed.marketId,
      marketIdB: position.marketId,
      correlationScore: parseFloat(rho.toFixed(4)),
      relationship: relationshipOf(rho),
      method,
    });
  }

  const totalCorrelatedExposure = Math.max(0, net);
  const maxCorrelatedUsdc = bankroll * MAX_CORRELATED_EXPOSURE_PCT;
  let adjustedPositionSize = proposedSize;
  if (totalCorrelatedExposure + proposedSize > maxCorrelatedUsdc) {
    adjustedPositionSize = Math.min(proposedSize, Math.max(0, maxCorrelatedUsdc - totalCorrelatedExposure));
    logger.info(
      { proposedSize, adjustedPositionSize, totalCorrelatedExposure },
      'Position reduced due to correlated exposure',
    );
  }

  return {
    hasCorrelatedPositions:  pairs.length > 0,
    correlatedPairs:         pairs,
    adjustedPositionSize:    parseFloat(adjustedPositionSize.toFixed(2)),
    totalCorrelatedExposure: parseFloat(totalCorrelatedExposure.toFixed(2)),
    method:                  usedSnapshot ? 'snapshot' : 'matrix',
    snapshotId:              snapshot?.id ?? null,
  };
}

/**
 * Checks if adding a new position creates excessive correlated exposure.
 * Uses the latest correlation snapshot per pair and falls back to the category
 * matrix when the snapshot is missing, stale or lacks the pair. Never computes
 * correlations inline.
 */
export async function checkCorrelation(
  proposedMarketId: string,
  proposedSize:     number,
  bankroll:         number,
  opts: { direction?: Direction; now?: Date } = {},
): Promise<CorrelationCheckResult> {
  const proposedMarket = await prisma.market.findUnique({
    where:  { id: proposedMarketId },
    select: { category: true, id: true },
  });

  if (!proposedMarket) {
    return {
      hasCorrelatedPositions:  false,
      correlatedPairs:         [],
      adjustedPositionSize:    proposedSize,
      totalCorrelatedExposure: 0,
      method:                  'matrix',
      snapshotId:              null,
    };
  }

  const openPositions = await prisma.position.findMany({
    where:   { status: 'OPEN' },
    include: { market: { select: { id: true, category: true } } },
  });
  const snapshot = await loadLatestSnapshot(opts.now);

  return evaluateCorrelation({
    proposed: { marketId: proposedMarketId, category: proposedMarket.category, direction: opts.direction },
    proposedSize,
    bankroll,
    positions: openPositions.map((p) => ({
      marketId: p.market.id,
      category: p.market.category,
      direction: p.direction,
      size: p.size,
    })),
    snapshot,
  });
}

/**
 * Returns all highly correlated pairs in the current open portfolio, plus the
 * full correlation matrix projected onto the nearest PSD matrix. Pair scores
 * are the raw pairwise values used for sizing; only `matrix` is projected.
 * Used by the portfolio endpoint to surface risk warnings. `bankroll` is the
 * treasury's free cash (#76); null when it could not be read, and then
 * `isOverExposed` is null too.
 */
export async function getPortfolioCorrelations(bankroll: number | null): Promise<{
  pairs:         CorrelationPair[];
  totalExposure: number;
  isOverExposed: boolean | null;
  matrix:        { marketIds: string[]; values: number[][] };
  method:        'snapshot' | 'matrix';
  snapshotId:    string | null;
}> {
  const openPositions = await prisma.position.findMany({
    where:   { status: 'OPEN' },
    include: { market: { select: { id: true, category: true } } },
  });
  const snapshot = await loadLatestSnapshot();

  const pairs: CorrelationPair[] = [];
  let usedSnapshot = false;
  for (let i = 0; i < openPositions.length; i++) {
    for (let j = i + 1; j < openPositions.length; j++) {
      const { rho, method } = pairCorrelation(openPositions[i].market, openPositions[j].market, snapshot);
      if (method !== 'matrix') usedSnapshot = true;
      if (Math.abs(rho) >= CORRELATION_THRESHOLD) {
        pairs.push({
          marketIdA:        openPositions[i].market.id,
          marketIdB:        openPositions[j].market.id,
          correlationScore: parseFloat(rho.toFixed(4)),
          relationship:     relationshipOf(rho),
          method,
        });
      }
    }
  }

  // The eigen-solver is for small matrices: report the 50 largest positions.
  const largest = [...openPositions].sort((a, b) => b.size - a.size).slice(0, 50);
  const ids = [...new Set(largest.map((p) => p.market.id))];
  const byId = new Map(largest.map((p) => [p.market.id, p.market]));
  const raw = ids.map((x) => ids.map((y) => (x === y ? 1 : pairCorrelation(byId.get(x)!, byId.get(y)!, snapshot).rho)));
  const values = nearestPsdCorrelation(raw).map((row) => row.map((v) => parseFloat(v.toFixed(4))));

  const totalExposure = openPositions.reduce((acc, p) => acc + p.size, 0);
  const isOverExposed = bankroll === null ? null : totalExposure > bankroll * MAX_CORRELATED_EXPOSURE_PCT * 2;

  return {
    pairs,
    totalExposure,
    isOverExposed,
    matrix: { marketIds: ids, values },
    method: usedSnapshot ? 'snapshot' : 'matrix',
    snapshotId: snapshot?.id ?? null,
  };
}
