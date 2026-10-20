/**
 * The trader's decision policy, free of Prisma, chain and wall-clock access:
 * everything it needs comes through a TraderEnv. Production runs it with
 * `prodTraderEnv()`; the backtester runs the same code against replayed
 * history (#81).
 *
 * Full flow:
 *   0. Read the treasury budget (capital and caps); skip the cycle if it
 *      cannot be read (#76)
 *   1. Check daily drawdown against the live bankroll — pause if limit hit
 *   2. Mark open positions to market, then stop-loss check (liquidation value)
 *   3. Check for hedge opportunities on deteriorating positions
 *   4. Scan active markets for +EV opportunities
 *   5. For each mispriced market: compute Kelly size, check correlation,
 *      clamp to the treasury's headroom in base units, then trace and execute
 */
import { calculateKellySize } from '../services/kelly';
import { evaluateDailyDrawdown } from '../services/hedging.service';
import {
  MIN_TRADE_RAW,
  budgetSnapshot,
  clampSize,
  spend,
  type SizingBinding,
  type TreasuryBudget,
} from '../services/treasury-budget.service';
import { toDisplayUsdc, usdcFromNumber } from '../lib/amounts';
import { config } from '../config';
import { logger } from '../lib/logger';
import type { MarketView, TraderEnv } from './trader-env';
import type { AggregatedSignals } from '../types';

export interface TraderParams {
  minEdge: number;
  minLiquidity: number;
  horizonDays: number;
  /** Share of daily and per-market headroom left unused, in basis points (#76). */
  headroomSafetyBps: number;
  /** A budget older than this is re-read before the next order (#76). */
  budgetMaxAgeMs: number;
}

export const DEFAULT_PARAMS: TraderParams = {
  minEdge: 0.08,
  minLiquidity: 500,
  horizonDays: 14,   // markets expiring within 14 days
  headroomSafetyBps: config.TREASURY_HEADROOM_SAFETY_BPS,
  budgetMaxAgeMs: 60_000,
};

/** The sizing decision recorded in the trace: every intermediate size in base units (#76). */
export interface SizingRecord {
  kellyRaw: string;
  correlationRaw: string;
  marketExposureRaw: string;
  marketExposureEstimated: boolean;
  finalRaw: string;
  binding: SizingBinding;
  safetyBps: number;
  budget: Record<string, string>;
}

/** Budget state shared by the orders of one cycle. */
interface CycleBudget {
  current: TreasuryBudget;
}

export async function runTraderPolicy(
  env: TraderEnv,
  params: TraderParams,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = opts;
  signal?.throwIfAborted();

  // Step 0: The treasury is the source of truth for capital and caps (#76).
  // Without it there is no safe size: fail closed, never fall back to a constant.
  let budget: TreasuryBudget;
  try {
    budget = await env.budget();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Trader Agent: treasury budget read failed — skipping cycle');
    await env.recordDecision({ kind: 'TREASURY_READ_FAILED', data: { error: String((err as Error)?.message ?? err).slice(0, 300) } });
    return;
  }
  const cycle: CycleBudget = { current: budget };
  const bankroll = toDisplayUsdc(budget.availableRaw);

  // Step 1: Check daily drawdown limit against the live bankroll
  const now = env.clock.now();
  const closedToday = await env.closedPnlSince(env.clock.startOfDay());
  const drawdown = evaluateDailyDrawdown(closedToday, bankroll, now);
  if (drawdown.isPaused) {
    await env.recordDecision({
      kind: 'DRAWDOWN_PAUSE',
      data: { drawdownPct: drawdown.drawdownPct, dailyLoss: drawdown.dailyLoss, pauseUntil: drawdown.pauseUntil?.toISOString() },
    });
    logger.warn({ drawdownPct: drawdown.drawdownPct }, 'Trader Agent: paused due to drawdown limit');
    return;
  }

  signal?.throwIfAborted();

  // Step 2: Mark to market, then check every open position
  await env.markToMarket?.();
  signal?.throwIfAborted();
  const openPositions = await env.openPositions();

  for (const position of openPositions) {
    signal?.throwIfAborted();
    const { shouldClose, reason } = await env.stopLoss(position);
    if (shouldClose && reason) {
      const exit = await env.exit(position.id, 'STOP_LOSS', position.currentPrice ?? position.entryPrice);
      await env.recordDecision({
        kind: 'STOP_LOSS', marketId: position.marketId,
        data: { positionId: position.id, reason, exited: exit.ok, ...(exit.reason ? { exitReason: exit.reason } : {}) },
      });
      logger.info({ positionId: position.id, reason, exited: exit.ok }, 'Stop-loss triggered');
    }
  }

  signal?.throwIfAborted();

  // Step 3: Hedge opportunities
  const hedgeRecs = await env.hedges();
  for (const rec of hedgeRecs) {
    signal?.throwIfAborted();
    try {
      await env.hedge(rec);
      await env.recordDecision({ kind: 'HEDGE', marketId: rec.hedgeMarketId, data: { ...rec } });
    } catch (err) {
      logger.warn({ err, rec }, 'Trader Agent: hedge failed');
    }
  }

  signal?.throwIfAborted();

  // Step 4: Scan markets for opportunities
  const signals = await env.signals(now, signal);
  const activeMarkets = await env.candidateMarkets(now, {
    minLiquidity: params.minLiquidity,
    horizonDays: params.horizonDays,
  });

  for (const market of activeMarkets) {
    signal?.throwIfAborted();
    await analyzeAndTradeMarket(env, params, cycle, market, signals, signal);
  }

  logger.info('Trader Agent: cycle complete');
}

async function analyzeAndTradeMarket(
  env: TraderEnv,
  params: TraderParams,
  cycle: CycleBudget,
  market: MarketView,
  signals: AggregatedSignals,
  signal?: AbortSignal,
): Promise<void> {
  try {
    // Skip if we already have an open position in this market
    if (await env.hasOpenPosition(market.id)) return;

    // Estimate probability using signal weighting
    const marketProb = market.currentYesProb ?? market.initialYesProb;
    const forecast = await env.forecast(market, signals);
    if (!forecast) return;
    const { p: agentProb, ci: confidenceInterval } = forecast;

    // Compute edge
    const edge = agentProb - marketProb;

    // Guard: insufficient edge
    if (Math.abs(edge) < params.minEdge) return;

    // Kelly sizing — use conservative end of CI. Everything is from the side
    // being bought: a NO bet compares P(NO) = 1 − ci.upper with the NO price
    // 1 − marketProb, never with the YES price.
    const conservativeProb = edge > 0 ? confidenceInterval.lower : 1 - confidenceInterval.upper;
    const sidePrice = edge > 0 ? marketProb : 1 - marketProb;
    // A budget read more than budgetMaxAgeMs ago is re-read before sizing.
    if (env.clock.now().getTime() - cycle.current.readAt.getTime() > params.budgetMaxAgeMs) {
      cycle.current = await env.budget();
    }
    const budget = cycle.current;
    const bankroll = toDisplayUsdc(budget.availableRaw);

    const kellyResult = calculateKellySize({
      agentProbability:  Math.max(0.01, conservativeProb),
      marketProbability: sidePrice,
      bankroll,
      netOdds:           (1 - sidePrice) / sidePrice,
    });

    // Correlation check — may reduce position size
    const direction = edge > 0 ? 'YES' : 'NO';

    if (kellyResult.betSize <= 0) {
      // The point edge clears minEdge but the conservative end of the interval
      // does not: intended, the forecast is too uncertain to size (#75).
      logger.debug({ marketId: market.id, edge, conservativeProb, sidePrice }, 'SIZE_ZERO_WIDE_CI: interval too wide to size');
      await env.recordDecision({
        kind: 'SKIP', marketId: market.id,
        data: { reason: 'SIZE_ZERO_WIDE_CI', direction, edge, p: agentProb, ci: confidenceInterval },
      });
      return;
    }
    const correlation = await env.correlation(market.id, kellyResult.betSize, direction, bankroll);

    // Treasury caps, in base units, before any trace exists (#76). Floats stop
    // here: Kelly and correlation are display-USDC inputs, the order is raw.
    const kellyRaw = usdcFromNumber(kellyResult.betSize);
    const correlationRaw = usdcFromNumber(Math.max(0, correlation.adjustedPositionSize));
    const exposure = await env.marketExposure(market.id);
    const headroomRaw = budget.maxMarketRaw > exposure.totalRaw ? budget.maxMarketRaw - exposure.totalRaw : 0n;
    const clamped = clampSize(correlationRaw, budget, headroomRaw, params.headroomSafetyBps);
    const binding: SizingBinding = clamped.binding === 'KELLY' && correlationRaw < kellyRaw ? 'CORRELATION' : clamped.binding;
    const sizing: SizingRecord = {
      kellyRaw: kellyRaw.toString(),
      correlationRaw: correlationRaw.toString(),
      marketExposureRaw: exposure.totalRaw.toString(),
      marketExposureEstimated: exposure.estimated,
      finalRaw: clamped.sizeRaw.toString(),
      binding,
      safetyBps: params.headroomSafetyBps,
      budget: budgetSnapshot(budget),
    };

    if (clamped.sizeRaw < MIN_TRADE_RAW) {
      logger.debug({ marketId: market.id, binding, finalRaw: sizing.finalRaw }, 'Position size below minimum after caps — skipping');
      await env.recordDecision({ kind: 'SKIP', marketId: market.id, data: { reason: 'SIZE_BELOW_MIN', direction, edge, sizing } });
      return;
    }

    const amount = toDisplayUsdc(clamped.sizeRaw);
    const price = direction === 'YES' ? marketProb : 1 - marketProb;

    signal?.throwIfAborted();

    const result = await env.buy({
      marketId: market.id,
      direction,
      amount,
      amountRaw: clamped.sizeRaw,
      price,
      marketProb,
      edge,
      kelly: kellyResult.halfKelly,
      forecast,
      correlation,
      sizing,
    });
    if (result.ok) cycle.current = spend(cycle.current, clamped.sizeRaw);
    await env.recordDecision({
      kind: result.ok ? 'BUY' : 'SKIP',
      marketId: market.id,
      data: { direction, amount, amountRaw: sizing.finalRaw, binding, edge, ...(result.reason ? { reason: result.reason } : {}) },
    });

    if (result.ok) logger.info({ marketId: market.id, direction, amount, binding, edge }, 'Trader Agent: trade executed');
  } catch (err) {
    logger.warn({ err, marketId: market.id }, 'Trader Agent: market analysis failed');
  }
}
