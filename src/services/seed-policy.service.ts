/**
 * Seed policy (#82): how much treasury capital a new market gets and where it
 * opens. Pure: no database, chain or clock access; the market maker gathers
 * the budget and passes it in.
 *
 * The seed is the largest and least controlled treasury spend, so it is
 * bounded by market-core's MIN_SEED below and by treasury headroom, an
 * aggregate cap on unresolved seeded capital and an LP-loss budget above. The
 * initial price is shrunk toward 0.5 in proportion to how unsure the model
 * says it is.
 */
import type { MarketCategory } from '@prisma/client';
import { MAX_PROB_BPS, MIN_PROB_BPS, MathError, calcBuy, priceYesBps, seedReserves } from '../generated/fpmm';
import { USDC_UNIT, usdcFromNumber } from '../lib/amounts';

/** market-core MIN_SEED is 100 USDC. */
export const MIN_SEED_RAW = 100n * USDC_UNIT;

const BPS = 10_000n;
/** The treasury's headroom is spent by other actors between the read and the write. */
const SAFETY_MARGIN_BPS = 9_500n;
const MAX_BISECTION_STEPS = 40;
const MAX_COLLATERAL_SEARCH_STEPS = 80;

export function initialYesBps(probability: number): number {
  return Math.min(9900, Math.max(100, Math.round(probability * 10_000)));
}

export type SeedBinding =
  | 'BASE'
  | 'MAX_TRADE'
  | 'MAX_MARKET'
  | 'MM_DAILY_SHARE'
  | 'DAILY_HEADROOM'
  | 'AVAILABLE_FRACTION'
  | 'AGGREGATE_CAP'
  | 'LP_LOSS_BUDGET';

export type SeedSkipReason = 'BELOW_MIN_SEED' | 'DAILY_BUDGET' | 'AGGREGATE_CAP' | 'LP_LOSS_BUDGET' | 'INSUFFICIENT_CAPITAL';

export interface SeedPolicyInput {
  category: MarketCategory;
  closeTime: Date;
  now: Date;
  /** The model's initial YES probability. */
  p: number;
  ci: { lower: number; upper: number };
  llmSuggestedSeedUsdc: number;
  budget: {
    availableRaw: bigint;
    maxTradeRaw: bigint;
    maxMarketRaw: bigint;
    maxDailyRaw: bigint;
    dailyUsedRaw: bigint;
    /** Seeds the market maker already spent in the treasury's current daily window. */
    mmSeededTodayRaw: bigint;
  };
  /** Σ seedAmountRaw of markets that are not final yet. */
  unresolvedSeededRaw: bigint;
}

export interface SeedPolicyConfig {
  lpLossBudgetRaw: bigint;
  mmDailyShareBps: number;
  maxSeedFractionBps: number;
  maxUnresolvedSeededRaw: bigint;
  /** Base seed in USDC per category. */
  categoryBaseUsdc: Record<string, number>;
  /** market-core's default_fee_bps (the pool's fee at creation). */
  feeBps: number;
  /** CI width at which the price is shrunk by the full SHRINK_MAX. */
  ciWidthForFullShrink?: number;
  shrinkMax?: number;
}

export type SeedDecision =
  | {
      action: 'create';
      seedRaw: bigint;
      initialYesBps: number;
      /** The price the market opens at; stored as Market.initialYesProb. */
      pAdj: number;
      expectedLpLossRaw: bigint;
      binding: SeedBinding;
      inputs: Record<string, string | number>;
    }
  | { action: 'skip'; reason: SeedSkipReason; inputs: Record<string, string | number> };

export const CI_WIDTH_FOR_FULL_SHRINK = 0.6;
export const SHRINK_MAX = 0.5;
const DEFAULT_BASE_USDC = 100;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** pAdj = 0.5 + (p − 0.5)(1 − w·SHRINK_MAX), w = clamp(width / CI_WIDTH_FOR_FULL_SHRINK, 0, 1). */
export function shrinkInitialPrice(p: number, ci: { lower: number; upper: number }, cfg: Pick<SeedPolicyConfig, 'ciWidthForFullShrink' | 'shrinkMax'> = {}): number {
  const w = clamp((ci.upper - ci.lower) / (cfg.ciWidthForFullShrink ?? CI_WIDTH_FOR_FULL_SHRINK), 0, 1);
  return 0.5 + (p - 0.5) * (1 - w * (cfg.shrinkMax ?? SHRINK_MAX));
}

/**
 * LP mark-to-market loss, in base units, when an informed trader moves a pool
 * seeded with `seed` at `openBps` to `targetBps` by buying the underpriced side.
 *
 * The treasury owns the pool's reserves plus its creator shares; their value at
 * the target price q is (YES·q + NO·(1−q)). At the opening price that equals the
 * seed, so loss = seed − value. All integer math from fpmm.ts, so it matches the
 * contract's rounding. Trading fees accrue outside the pool and are ignored.
 */
export function expectedLpLoss(seed: bigint, openBps: number, targetBps: number, feeBps: number): bigint {
  const open = clampBps(openBps);
  const target = clampBps(targetBps);
  if (target === open || seed <= 0n) return 0n;

  let seeded;
  try {
    seeded = seedReserves(seed, BigInt(open));
  } catch (err) {
    if (err instanceof MathError) return 0n;
    throw err;
  }
  const buyYes = target > open;

  // After buying `collateral` of the underpriced side: [reserveYes, reserveNo].
  const after = (collateral: bigint): [bigint, bigint] | null => {
    try {
      if (buyYes) {
        const q = calcBuy(seeded.reserveYes, seeded.reserveNo, collateral, BigInt(feeBps));
        return [q.newReserveBought, q.newReserveOther];
      }
      const q = calcBuy(seeded.reserveNo, seeded.reserveYes, collateral, BigInt(feeBps));
      return [q.newReserveOther, q.newReserveBought];
    } catch (err) {
      if (err instanceof MathError) return null;
      throw err;
    }
  };
  const reached = (collateral: bigint) => {
    const r = after(collateral);
    if (!r) return true; // beyond what the pool can fill: treat the target as reached
    const price = Number(priceYesBps(r[0], r[1]));
    return buyYes ? price >= target : price <= target;
  };

  // Smallest collateral that moves the price to the target (the price is monotone in it).
  let lo = 1n;
  let hi = seed * 1_000n;
  for (let i = 0; i < MAX_COLLATERAL_SEARCH_STEPS && lo < hi; i++) {
    const mid = (lo + hi) / 2n;
    if (reached(mid)) hi = mid;
    else lo = mid + 1n;
  }
  const end = after(hi) ?? after(hi / 2n);
  if (!end) return 0n;

  const yes = end[0] + seeded.creatorYes;
  const no = end[1] + seeded.creatorNo;
  const q = BigInt(target);
  const value = (yes * q + no * (BPS - q)) / BPS;
  return value >= seed ? 0n : seed - value;
}

function clampBps(bps: number): number {
  return Math.min(Number(MAX_PROB_BPS), Math.max(Number(MIN_PROB_BPS), Math.round(bps)));
}

/**
 * The CI bound farthest from the opening price: where an informed trader
 * would push it if the true probability sits at that edge of the interval.
 */
export function worstCaseTargetBps(pAdj: number, ci: { lower: number; upper: number }): number {
  const farthest = Math.abs(ci.lower - pAdj) >= Math.abs(ci.upper - pAdj) ? ci.lower : ci.upper;
  return clampBps(farthest * 10_000);
}

const BINDING_SKIP: Record<SeedBinding, SeedSkipReason> = {
  BASE: 'BELOW_MIN_SEED',
  MAX_TRADE: 'BELOW_MIN_SEED',
  MAX_MARKET: 'BELOW_MIN_SEED',
  MM_DAILY_SHARE: 'DAILY_BUDGET',
  DAILY_HEADROOM: 'DAILY_BUDGET',
  AVAILABLE_FRACTION: 'INSUFFICIENT_CAPITAL',
  AGGREGATE_CAP: 'AGGREGATE_CAP',
  LP_LOSS_BUDGET: 'LP_LOSS_BUDGET',
};

const nonNegative = (x: bigint) => (x < 0n ? 0n : x);

export function decideSeed(i: SeedPolicyInput, cfg: SeedPolicyConfig): SeedDecision {
  const pAdj = shrinkInitialPrice(i.p, i.ci, cfg);
  const openBps = initialYesBps(pAdj);
  const targetBps = worstCaseTargetBps(pAdj, i.ci);

  // Base seed: category table scaled by time to close, which the LLM can lower but not inflate.
  const daysToClose = Math.max(0, (i.closeTime.getTime() - i.now.getTime()) / 86_400_000);
  const timeFactor = clamp(Math.sqrt(daysToClose / 30), 0.5, 1.5);
  const categoryBase = cfg.categoryBaseUsdc[i.category] ?? DEFAULT_BASE_USDC;
  const baseUsdc = Math.min(categoryBase * timeFactor, i.llmSuggestedSeedUsdc * 2);
  const baseRaw = nonNegative(usdcFromNumber(baseUsdc));
  const floorRaw = baseRaw < MIN_SEED_RAW ? MIN_SEED_RAW : baseRaw;

  const b = i.budget;
  const bounds: Array<[SeedBinding, bigint]> = [
    ['BASE', floorRaw],
    ['MAX_TRADE', (b.maxTradeRaw * SAFETY_MARGIN_BPS) / BPS],
    ['MAX_MARKET', (b.maxMarketRaw * SAFETY_MARGIN_BPS) / BPS],
    ['MM_DAILY_SHARE', nonNegative((b.maxDailyRaw * BigInt(cfg.mmDailyShareBps)) / BPS - b.mmSeededTodayRaw)],
    ['DAILY_HEADROOM', (nonNegative(b.maxDailyRaw - b.dailyUsedRaw) * SAFETY_MARGIN_BPS) / BPS],
    ['AVAILABLE_FRACTION', (b.availableRaw * BigInt(cfg.maxSeedFractionBps)) / BPS],
    ['AGGREGATE_CAP', nonNegative(cfg.maxUnresolvedSeededRaw - i.unresolvedSeededRaw)],
  ];

  const inputs: Record<string, string | number> = {
    category: i.category,
    p: i.p,
    ciLower: i.ci.lower,
    ciUpper: i.ci.upper,
    pAdj,
    initialYesBps: openBps,
    worstCaseTargetBps: targetBps,
    daysToClose: Number(daysToClose.toFixed(3)),
    timeFactor: Number(timeFactor.toFixed(4)),
    llmSuggestedSeedUsdc: i.llmSuggestedSeedUsdc,
    baseSeedRaw: floorRaw.toString(),
    feeBps: cfg.feeBps,
    lpLossBudgetRaw: cfg.lpLossBudgetRaw.toString(),
    unresolvedSeededRaw: i.unresolvedSeededRaw.toString(),
    mmSeededTodayRaw: b.mmSeededTodayRaw.toString(),
    availableRaw: b.availableRaw.toString(),
    dailyUsedRaw: b.dailyUsedRaw.toString(),
  };
  for (const [name, value] of bounds) inputs[`bound_${name}`] = value.toString();

  const [binding, ceiling] = bounds.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  if (ceiling < MIN_SEED_RAW) return { action: 'skip', reason: BINDING_SKIP[binding], inputs };

  const loss = (seed: bigint) => expectedLpLoss(seed, openBps, targetBps, cfg.feeBps);

  if (loss(ceiling) <= cfg.lpLossBudgetRaw) {
    return { action: 'create', seedRaw: ceiling, initialYesBps: openBps, pAdj, expectedLpLossRaw: loss(ceiling), binding, inputs };
  }
  if (loss(MIN_SEED_RAW) > cfg.lpLossBudgetRaw) {
    inputs.lossAtMinSeedRaw = loss(MIN_SEED_RAW).toString();
    return { action: 'skip', reason: 'LP_LOSS_BUDGET', inputs };
  }

  // Largest seed whose expected loss still fits the budget (loss grows with the seed).
  let lo = MIN_SEED_RAW;
  let hi = ceiling;
  for (let step = 0; step < MAX_BISECTION_STEPS && hi - lo > 1n; step++) {
    const mid = (lo + hi) / 2n;
    if (loss(mid) <= cfg.lpLossBudgetRaw) lo = mid;
    else hi = mid;
  }
  return { action: 'create', seedRaw: lo, initialYesBps: openBps, pAdj, expectedLpLossRaw: loss(lo), binding: 'LP_LOSS_BUDGET', inputs };
}

/** JSON-safe record of a create decision, stored in Market.seedPolicy and the creation trace. */
export function seedPolicyRecord(d: Extract<SeedDecision, { action: 'create' }>): Record<string, unknown> {
  return {
    seedRaw: d.seedRaw.toString(),
    initialYesBps: d.initialYesBps,
    pAdj: d.pAdj,
    expectedLpLossRaw: d.expectedLpLossRaw.toString(),
    binding: d.binding,
    inputs: d.inputs,
  };
}
