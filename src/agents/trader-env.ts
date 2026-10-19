/**
 * What the trader's decision policy (trader-policy.ts) may touch: a clock,
 * reads of markets, positions and signals, execution, and a decision sink.
 * Production wraps Prisma and the chain service (`prodTraderEnv`); the
 * backtester (src/backtest/) supplies replayed history instead (#81).
 */
import { aggregateSignals } from '../services/ingestion.service';
import { executeTrade } from '../services/trade.service';
import { ForecastSession, forecastMarket, rankForForecast, type ForecastMarket } from '../services/forecast.service';
import { exitPosition } from '../services/exit.service';
import { markOpenPositions } from '../services/valuation.service';
import { checkCorrelation } from '../services/correlation.service';
import { evidenceFromSignals, generateReasoningTrace } from '../services/reasoning.service';
import { detectHedgeOpportunities, autoHedge, enforceStopLoss } from '../services/hedging.service';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { writeAgentLog } from '../lib/agent-log';
import { now as clockNow } from '../lib/clock';
import {
  budgetSnapshot,
  marketExposureRaw,
  readTreasuryBudget,
  type MarketExposure,
  type TreasuryBudget,
} from '../services/treasury-budget.service';
import type { SizingRecord } from './trader-policy';
import { recordDrawdownPause, utcStartOfDay, type DrawdownEvaluation } from '../services/hedging.service';
import type {
  AggregatedSignals,
  ConfidenceInterval,
  CorrelationCheckResult,
  EnsembleForecast,
  HedgeRecommendation,
  WeightedSignal,
} from '../types';

export type TradeDirection = 'YES' | 'NO';

export interface Clock {
  now(): Date;
  /** Start of the current day in UTC. */
  startOfDay(): Date;
}

export interface PositionView {
  id: string;
  marketId: string;
  /** Market category, when the env knows it (used by the correlation and hedge checks). */
  category?: string;
  direction: TradeDirection;
  entryPrice: number;
  currentPrice: number | null;
  size: number;
  pnl: number;
}

export interface MarketView {
  id: string;
  category: string;
  currentYesProb: number | null;
  initialYesProb: number;
  totalLiquidity: number;
  expiryTimestamp: Date;
  /** What the forecaster reads (#75); absent in a backtest replay. */
  question?: string;
  resolutionOracle?: string | null;
  metaUri?: string | null;
  questionHash?: string | null;
}

export interface Forecast {
  p: number;
  ci: ConfidenceInterval;
  /** Signals behind the estimate, recorded in the reasoning trace. */
  sources: WeightedSignal[];
  /** Per-model forecasts, weights and input digests (#75), pinned in the trace. */
  ensemble?: EnsembleForecast;
}

export interface BuyOrder {
  marketId: string;
  direction: TradeDirection;
  /** USDC display value of amountRaw. */
  amount: number;
  /** Final size in base units, after correlation and the treasury caps (#76). */
  amountRaw: bigint;
  /** Probability of the side being bought, at decision time. */
  price: number;
  marketProb: number;
  edge: number;
  kelly: number;
  forecast: Forecast;
  correlation: CorrelationCheckResult;
  /** Kelly → correlation → caps, with the binding constraint and budget snapshot (#76). */
  sizing: SizingRecord;
}

export interface ExecResult {
  ok: boolean;
  /** Why an order was refused (a cap name in a backtest). */
  reason?: string;
}

export interface DecisionRecord {
  kind: 'DRAWDOWN_PAUSE' | 'STOP_LOSS' | 'HEDGE' | 'SKIP' | 'BUY' | 'TREASURY_READ_FAILED';
  marketId?: string;
  data: Record<string, unknown>;
}

export interface TraderEnv {
  clock: Clock;
  /** Treasury capital and caps (#76). Throws when they cannot be read; the cycle then trades nothing. */
  budget(): Promise<TreasuryBudget>;
  /** The treasury's cumulative spend on a market, as max_market counts it (#76). */
  marketExposure(marketId: string): Promise<MarketExposure>;
  openPositions(): Promise<PositionView[]>;
  hasOpenPosition(marketId: string): Promise<boolean>;
  candidateMarkets(now: Date, filter: { minLiquidity: number; horizonDays: number }): Promise<MarketView[]>;
  signals(now: Date, signal?: AbortSignal): Promise<AggregatedSignals>;
  /** P&L of positions closed since `t`, for the daily drawdown check. */
  closedPnlSince(t: Date): Promise<number[]>;
  forecast(m: MarketView, s: AggregatedSignals): Promise<Forecast | null>;
  /** Marks open positions to market from the latest reserves (#78); a backtest values its own pools. */
  markToMarket?(): Promise<void>;
  stopLoss(position: PositionView): Promise<{ shouldClose: boolean; reason?: string }>;
  /** `bankroll` is the cycle's free treasury cash in USDC; the correlated-exposure cap is a share of it. */
  correlation(marketId: string, size: number, direction: TradeDirection, bankroll: number): Promise<CorrelationCheckResult>;
  hedges(): Promise<HedgeRecommendation[]>;
  hedge(rec: HedgeRecommendation): Promise<void>;
  buy(order: BuyOrder): Promise<ExecResult>;
  exit(positionId: string, reason: string, price: number): Promise<ExecResult>;
  /** Trace sink: every decision the policy makes that is worth keeping. */
  recordDecision(d: DecisionRecord): Promise<void>;
}

/** Production env: Prisma, the chain service, the reasoning service and the wall clock. */
export function prodTraderEnv(): TraderEnv {
  // One env per cycle, so one forecast budget per cycle (#75).
  const forecastSession = new ForecastSession();
  return {
    clock: {
      now: () => clockNow(),
      startOfDay: () => utcStartOfDay(clockNow()),
    },

    budget: () => readTreasuryBudget(),

    async marketExposure(marketId) {
      const market = await prisma.market.findUnique({ where: { id: marketId }, select: { onChainMarketId: true } });
      return marketExposureRaw(marketId, market?.onChainMarketId ?? null);
    },

    async openPositions() {
      const rows = await prisma.position.findMany({ where: { status: 'OPEN' } });
      return rows.map((p) => ({
        id: p.id, marketId: p.marketId, direction: p.direction, entryPrice: p.entryPrice,
        currentPrice: p.currentPrice, size: p.size, pnl: p.pnl,
      }));
    },

    async hasOpenPosition(marketId) {
      return Boolean(await prisma.position.findFirst({ where: { marketId, status: 'OPEN' } }));
    },

    async candidateMarkets(now, { minLiquidity, horizonDays }) {
      const markets = await prisma.market.findMany({
        where: {
          status:         'ACTIVE',
          totalLiquidity: { gte: minLiquidity },
          expiryTimestamp: {
            gt:  now,
            lte: new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000),
          },
        },
      });
      // The forecast cap (#75) goes to markets without a recent forecast, soonest close first.
      return rankForForecast(markets);
    },

    signals: (_now, signal) => aggregateSignals(signal),

    async closedPnlSince(t) {
      const rows = await prisma.position.findMany({
        where: { status: { in: ['CLOSED', 'STOP_LOSS'] }, closedAt: { gte: t } },
        select: { pnl: true },
      });
      return rows.map((r) => r.pnl);
    },

    // An independent estimate (#75): the forecaster never sees the price. The
    // old code echoed the price through calculateProbability, so edge was 0.
    async forecast(market, signals) {
      if (!market.question) return null;
      const result = await forecastMarket(market as ForecastMarket, signals, forecastSession);
      if (!result) return null;
      return {
        p: result.forecast.p,
        ci: result.forecast.ci,
        sources: evidenceFromSignals(result.relevant),
        ensemble: result.forecast,
      };
    },

    async markToMarket() {
      await markOpenPositions();
    },

    stopLoss: (position) => enforceStopLoss(position.id),

    correlation: (marketId, size, direction, bankroll) => checkCorrelation(marketId, size, bankroll, { direction }),

    hedges: () => detectHedgeOpportunities(),

    async hedge(rec) {
      await autoHedge(rec);
    },

    async buy(order) {
      // Generate reasoning trace BEFORE executing
      const { trace, tracePayload } = await generateReasoningTrace({
        marketId:            order.marketId,
        agentType:           'TRADER',
        decisionType:        'OPEN_POSITION',
        sourcesUsed:         order.forecast.sources,
        probabilityEstimate: order.forecast.p,
        marketProbability:   order.marketProb,
        edge:                order.edge,
        confidenceInterval:  order.forecast.ci,
        forecast:            order.forecast.ensemble as unknown as Record<string, unknown> | undefined,
        betFraction:         order.kelly,
        betSizeUsdc:         order.amount,
        sizing:              order.sizing as unknown as Record<string, unknown>,
        correlation: {
          pairs:      order.correlation.correlatedPairs,
          method:     order.correlation.method ?? 'matrix',
          snapshotId: order.correlation.snapshotId ?? null,
        },
      });

      // Execute trade (Never abort between chain write and DB update)
      await executeTrade({
        marketId:      order.marketId,
        direction:     order.direction,
        amount:        order.amount,
        amountRaw:     order.amountRaw,
        budget:        order.sizing.budget,
        price:         order.price,
        kellyFraction: order.kelly,
        edgeDetected:  order.edge,
        traceId:       trace.id,
        tracePayload,
      });
      return { ok: true };
    },

    // A real exit: agent_sell on-chain, the position changes only once it confirms (#77).
    async exit(positionId, reason) {
      const result = await exitPosition(positionId, { reason });
      return { ok: result.status === 'CONFIRMED' || result.status === 'SIMULATED', ...(result.code ? { reason: result.code } : {}) };
    },

    async recordDecision(d) {
      if (d.kind === 'TREASURY_READ_FAILED') {
        await writeAgentLog({ agentType: 'TRADER', level: 'WARN', action: 'TREASURY_READ_FAILED', data: d.data }).catch(() => {});
        return;
      }
      if (d.kind === 'DRAWDOWN_PAUSE') {
        const { drawdownPct, dailyLoss, pauseUntil } = d.data as { drawdownPct: number; dailyLoss: number; pauseUntil?: string };
        const evaluation: DrawdownEvaluation = {
          isPaused: true, drawdownPct, dailyLoss, pauseUntil: pauseUntil ? new Date(pauseUntil) : undefined,
        };
        await recordDrawdownPause(evaluation);
        return;
      }
      logger.debug({ decision: d.kind, marketId: d.marketId, ...d.data }, 'Trader decision');
    },
  };
}

