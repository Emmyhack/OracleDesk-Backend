/**
 * A TraderEnv with in-memory answers, for driving runTraderPolicy without
 * Prisma, the chain or the wall clock. Every call is recorded.
 */
import type { BuyOrder, DecisionRecord, Forecast, MarketView, TraderEnv } from '../../src/agents/trader-env';
import type { TreasuryBudget } from '../../src/services/treasury-budget.service';
import type { AggregatedSignals } from '../../src/types';

export const USDC = 10_000_000n;
export const T0 = new Date('2026-10-18T12:00:00Z');

export function budget(over: Partial<TreasuryBudget> = {}): TreasuryBudget {
  const maxDailyRaw = over.maxDailyRaw ?? 5_000n * USDC;
  const dailyUsedRaw = over.dailyUsedRaw ?? 0n;
  return {
    availableRaw: 10_000n * USDC,
    maxTradeRaw: 1_000n * USDC,
    maxMarketRaw: 2_000n * USDC,
    maxDailyRaw,
    dailyUsedRaw,
    dailyRemainingRaw: maxDailyRaw > dailyUsedRaw ? maxDailyRaw - dailyUsedRaw : 0n,
    dailyWindowStart: new Date(T0.getTime() - 3_600_000),
    dailyResetsAt: new Date(T0.getTime() + 23 * 3_600_000),
    readAt: T0,
    ...over,
  };
}

export function market(over: Partial<MarketView> = {}): MarketView {
  return {
    id: 'm1',
    category: 'FED',
    currentYesProb: 0.55,
    initialYesProb: 0.5,
    totalLiquidity: 5_000,
    expiryTimestamp: new Date(T0.getTime() + 7 * 86_400_000),
    ...over,
  };
}

export interface FakeEnv extends TraderEnv {
  buys: BuyOrder[];
  decisions: DecisionRecord[];
  calls: string[];
  correlationBankrolls: number[];
  budgetReads: number;
}

export function fakeTraderEnv(opts: {
  budget?: () => Promise<TreasuryBudget>;
  markets?: MarketView[];
  forecast?: (m: MarketView) => Forecast | null;
  exposureRaw?: bigint;
  closedPnl?: number[];
  /** Fraction of the proposed size the correlation check keeps. */
  correlationKeep?: number;
  now?: () => Date;
} = {}): FakeEnv {
  const env: FakeEnv = {
    buys: [],
    decisions: [],
    calls: [],
    correlationBankrolls: [],
    budgetReads: 0,
    clock: { now: opts.now ?? (() => T0), startOfDay: () => new Date('2026-10-18T00:00:00Z') },
    async budget() {
      env.budgetReads++;
      env.calls.push('budget');
      return (opts.budget ?? (async () => budget()))();
    },
    async marketExposure() {
      return { totalRaw: opts.exposureRaw ?? 0n, estimated: false };
    },
    async openPositions() { env.calls.push('openPositions'); return []; },
    async hasOpenPosition() { return false; },
    async candidateMarkets() { env.calls.push('candidateMarkets'); return opts.markets ?? [market()]; },
    async signals(): Promise<AggregatedSignals> {
      env.calls.push('signals');
      return { news: [], fed: [], macro: [], aggregatedAt: T0, signalCount: 0 };
    },
    async closedPnlSince() { env.calls.push('closedPnlSince'); return opts.closedPnl ?? []; },
    async forecast(m) {
      return (opts.forecast ?? (() => ({ p: 0.75, ci: { lower: 0.7, upper: 0.8 }, sources: [] })))(m);
    },
    async stopLoss() { return { shouldClose: false }; },
    async correlation(marketId, size, _direction, bankroll) {
      env.correlationBankrolls.push(bankroll);
      const keep = opts.correlationKeep ?? 1;
      return {
        hasCorrelatedPositions: keep < 1,
        correlatedPairs: [],
        adjustedPositionSize: parseFloat((size * keep).toFixed(2)),
        totalCorrelatedExposure: 0,
        method: 'matrix',
        snapshotId: null,
      };
    },
    async hedges() { return []; },
    async hedge() {},
    async buy(order) { env.buys.push(order); return { ok: true }; },
    async exit() { return { ok: true }; },
    async recordDecision(d) { env.decisions.push(d); },
  };
  return env;
}
