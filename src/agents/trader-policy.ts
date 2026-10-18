/**
 * The trader's decision policy, free of Prisma, chain and wall-clock access:
 * everything it needs comes through a TraderEnv. Production runs it with
 * `prodTraderEnv()`; the backtester runs the same code against replayed
 * history (#81).
 *
 * Full flow:
 *   1. Check daily drawdown — pause if limit hit
 *   2. Mark open positions to market, then stop-loss check (liquidation value)
 *   3. Check for hedge opportunities on deteriorating positions
 *   4. Scan active markets for +EV opportunities
 *   5. For each mispriced market: compute Kelly size, check correlation, execute
 */
import { calculateKellySize } from '../services/kelly';
import { evaluateDailyDrawdown } from '../services/hedging.service';
import { logger } from '../lib/logger';
import type { MarketView, TraderEnv } from './trader-env';
import type { AggregatedSignals } from '../types';

export interface TraderParams {
  minEdge: number;
  minLiquidity: number;
  horizonDays: number;
  bankroll: number;
}

export const DEFAULT_PARAMS: TraderParams = {
  minEdge: 0.08,
  minLiquidity: 500,
  horizonDays: 14,   // markets expiring within 14 days
  bankroll: 10_000,  // $10,000 USDC starting bankroll
};

export async function runTraderPolicy(
  env: TraderEnv,
  params: TraderParams,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = opts;
  signal?.throwIfAborted();

  // Step 1: Check daily drawdown limit
  const now = env.clock.now();
  const closedToday = await env.closedPnlSince(env.clock.startOfDay());
  const drawdown = evaluateDailyDrawdown(closedToday, params.bankroll, now);
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
    await analyzeAndTradeMarket(env, params, market, signals, signal);
  }

  logger.info('Trader Agent: cycle complete');
}

async function analyzeAndTradeMarket(
  env: TraderEnv,
  params: TraderParams,
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

    // Kelly sizing — use conservative end of CI
    const conservativeProb = edge > 0 ? confidenceInterval.lower : 1 - confidenceInterval.upper;
    const kellyResult = calculateKellySize({
      agentProbability:  Math.max(0.01, conservativeProb),
      marketProbability: marketProb,
      bankroll:          params.bankroll,
      netOdds:           edge > 0 ? (1 - marketProb) / marketProb : marketProb / (1 - marketProb),
    });

    if (kellyResult.betSize <= 0) return;

    // Correlation check — may reduce position size
    const direction = edge > 0 ? 'YES' : 'NO';
    const correlation = await env.correlation(market.id, kellyResult.betSize, direction);
    const finalSize = correlation.adjustedPositionSize;

    if (finalSize < 1) {
      logger.debug({ marketId: market.id }, 'Position size too small after correlation adjustment — skipping');
      return;
    }

    const price = direction === 'YES' ? marketProb : 1 - marketProb;

    signal?.throwIfAborted();

    const result = await env.buy({
      marketId: market.id,
      direction,
      amount: finalSize,
      price,
      marketProb,
      edge,
      kelly: kellyResult.halfKelly,
      forecast,
      correlation,
    });
    await env.recordDecision({
      kind: result.ok ? 'BUY' : 'SKIP',
      marketId: market.id,
      data: { direction, amount: finalSize, edge, ...(result.reason ? { reason: result.reason } : {}) },
    });

    if (result.ok) logger.info({ marketId: market.id, direction, amount: finalSize, edge }, 'Trader Agent: trade executed');
  } catch (err) {
    logger.warn({ err, marketId: market.id }, 'Trader Agent: market analysis failed');
  }
}
