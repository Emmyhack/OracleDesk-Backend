import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { writeAgentLog } from '../lib/agent-log';
import { AppError } from '../middlewares/error.middleware';
import type { HedgeRecommendation } from '../types';
import { decimalToBigint } from '../lib/amounts';
import { pauseAgent } from './agent-controls.service';

// ─── Hedging constants ───
const HEDGE_TRIGGER_EDGE_DECAY  = 0.50;  // Hedge when edge decays by 50%
const HEDGE_SIZE_FRACTION       = 0.50;  // Hedge 50% of original position
const MAX_DAILY_DRAWDOWN_PCT    = 0.03;  // 3% daily drawdown → pause agent
const DRAWDOWN_PAUSE_HOURS      = 4;     // Pause for 4 hours on max drawdown
const STOP_LOSS_PCT_BPS         = 1_500n; // Exit once the liquidation value is 15% below cost
const HEDGE_LOSS_PCT_BPS        = 1_000n; // Hedge once the liquidation value is 10% below cost

/**
 * Start of the current day in UTC. The daily drawdown window used to be local
 * midnight, which moved with the server's time zone: replicas in different
 * zones disagreed about "today". UTC makes it the same everywhere (#79).
 */
export function utcStartOfDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** What the hedge scan needs to know about an open position. */
export interface HedgePositionInput {
  marketId:     string;
  category:     string;
  direction:    'YES' | 'NO';
  entryPrice:   number;
  currentPrice: number | null;
  size:         number;
  pnl:          number;
  /** Raw cost and liquidation-based unrealised PnL (#78); the loss test prefers them over `pnl`. */
  costBasisRaw?:     bigint | null;
  unrealisedPnlRaw?: bigint | null;
  /** The edge detected when the position was opened. */
  edgeDetected: number;
}

/**
 * Pure core of the hedge scan: which positions need hedging and against which
 * market. `pickMarket` finds the hedge market (the database in production, the
 * replayed pools in a backtest).
 *
 * A position needs hedging when:
 * 1. The current market price has moved adversely by > 8%
 *    (edge from entry is now < 50% of original edge)
 * 2. OR the position is showing unrealised loss > 10% of size
 *
 * For each position needing a hedge, we search for:
 * - A market in the same category with OPPOSITE directional exposure
 * - Sufficient liquidity (>= $500) to accept a meaningful hedge
 */
export async function planHedges(
  positions: HedgePositionInput[],
  pickMarket: (category: string, excludeMarketId: string, direction: 'YES' | 'NO') => Promise<{ id: string } | null>,
): Promise<HedgeRecommendation[]> {
  const recommendations: HedgeRecommendation[] = [];

  for (const position of positions) {
    const originalEdge = position.edgeDetected;
    const currentPrice = position.currentPrice ?? position.entryPrice;

    // Calculate current edge degradation
    const entryEdge = position.direction === 'YES'
      ? originalEdge
      : -originalEdge;

    const priceChange = currentPrice - position.entryPrice;
    const currentEdge = entryEdge - priceChange;

    const edgeDegraded = currentEdge < entryEdge * (1 - HEDGE_TRIGGER_EDGE_DECAY);
    const hasLoss = position.costBasisRaw != null && position.unrealisedPnlRaw != null
      ? lossReaches(position.costBasisRaw, position.unrealisedPnlRaw, HEDGE_LOSS_PCT_BPS)
      : position.pnl < -(position.size * 0.10);

    if (!edgeDegraded && !hasLoss) continue;

    // Find a hedge market: same category, enough liquidity
    const hedgeMarket = await pickMarket(position.category, position.marketId, position.direction);

    if (!hedgeMarket) continue;

    const hedgeSize = position.size * HEDGE_SIZE_FRACTION;
    const hedgeDirection = position.direction === 'YES' ? 'NO' : 'YES';

    recommendations.push({
      originalMarketId: position.marketId,
      hedgeMarketId:    hedgeMarket.id,
      hedgeDirection,
      hedgeSize,
      rationale: `Edge decayed from ${entryEdge.toFixed(3)} to ${currentEdge.toFixed(3)}. ` +
                 `Partial hedge of ${hedgeSize} USDC via ${hedgeMarket.id} reduces net exposure by ~50%.`,
    });
  }

  return recommendations;
}

/** Scans all open positions in the database and identifies which ones need hedging. */
export async function detectHedgeOpportunities(): Promise<HedgeRecommendation[]> {
  const openPositions = await prisma.position.findMany({
    where:   { status: 'OPEN' },
    include: { market: { select: { id: true, category: true, currentYesProb: true, totalLiquidity: true } }, trade: true },
  });

  return planHedges(
    openPositions.map((position) => ({
      marketId:     position.market.id,
      category:     position.market.category,
      direction:    position.direction,
      entryPrice:   position.entryPrice,
      currentPrice: position.currentPrice,
      size:         position.size,
      pnl:          position.pnl,
      costBasisRaw:     position.costBasisRaw == null ? null : decimalToBigint(position.costBasisRaw),
      unrealisedPnlRaw: position.unrealisedPnlRaw == null ? null : decimalToBigint(position.unrealisedPnlRaw),
      edgeDetected: position.trade?.edgeDetected ?? 0,
    })),
    findHedgeMarket,
  );
}

/**
 * Executes a hedge position for a given recommendation.
 *
 * The hedge is sized at HEDGE_SIZE_FRACTION (50%) of the original position.
 * It takes the OPPOSITE direction to the original bet.
 *
 * All hedge trades and rationales are written to agent_logs for auditability.
 */
export async function autoHedge(recommendation: HedgeRecommendation): Promise<any> {
  const hedgeMarket = await prisma.market.findUnique({
    where: { id: recommendation.hedgeMarketId },
  });

  if (!hedgeMarket) {
    throw new AppError(404, 'HEDGE_MARKET_NOT_FOUND', 'Hedge market not found');
  }

  if ((hedgeMarket.totalLiquidity ?? 0) < 500) {
    throw new AppError(400, 'INSUFFICIENT_HEDGE_LIQUIDITY', 
      'Hedge market has insufficient liquidity');
  }

  // Create a hedge trade record
  const hedgeTrade = await prisma.trade.create({
    data: {
      marketId:      recommendation.hedgeMarketId,
      direction:     recommendation.hedgeDirection,
      status:        'PENDING',
      amount:        recommendation.hedgeSize,
      price:         recommendation.hedgeDirection === 'YES'
                       ? hedgeMarket.currentYesProb ?? 0.5
                       : 1 - (hedgeMarket.currentYesProb ?? 0.5),
      edgeDetected:  0, // Hedges don't require positive edge
      kellyFraction: 0,
    },
  });

  // Log the hedge rationale for auditability
  await writeAgentLog({
    agentType: 'TRADER',
    level:     'INFO',
    action:    'AUTO_HEDGE_EXECUTED',
    marketId:  recommendation.hedgeMarketId,
    data: {
      originalMarketId: recommendation.originalMarketId,
      hedgeTradeId:     hedgeTrade.id,
      hedgeDirection:   recommendation.hedgeDirection,
      hedgeSize:        recommendation.hedgeSize,
      rationale:        recommendation.rationale,
    },
  });

  logger.info(
    { hedgeTradeId: hedgeTrade.id, rationale: recommendation.rationale },
    'Auto-hedge executed',
  );

  return hedgeTrade;
}

/**
 * Implements hard stop-loss logic.
 *
 * Called by the position monitor every 15 minutes.
 * Closes positions where:
 *   - Market has moved 15%+ against the position
 *   - Daily drawdown of the entire portfolio exceeds 3%
 */
export async function enforceStopLoss(positionId: string): Promise<{
  shouldClose: boolean;
  reason?: string;
}> {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
  });

  if (!position || position.status !== 'OPEN') {
    return { shouldClose: false };
  }

  // Positions marked to market stop out on what selling them would return (#78).
  if (position.costBasisRaw != null && position.unrealisedPnlRaw != null) {
    return evaluateLiquidationStopLoss(decimalToBigint(position.costBasisRaw), decimalToBigint(position.unrealisedPnlRaw));
  }
  return evaluateStopLoss(position);
}

/** True when the unrealised loss is at least `pctBps` of the cost basis. */
export function lossReaches(costBasisRaw: bigint, unrealisedPnlRaw: bigint, pctBps: bigint): boolean {
  return costBasisRaw > 0n && unrealisedPnlRaw < 0n && -unrealisedPnlRaw * 10_000n >= costBasisRaw * pctBps;
}

/**
 * Stop-loss on liquidation value: close once unrealisedPnlRaw <= -15% of the
 * cost basis. It sees price impact and fees, which a price-move rule does not.
 */
export function evaluateLiquidationStopLoss(costBasisRaw: bigint, unrealisedPnlRaw: bigint): {
  shouldClose: boolean;
  reason?: string;
} {
  if (!lossReaches(costBasisRaw, unrealisedPnlRaw, STOP_LOSS_PCT_BPS)) return { shouldClose: false };
  const lossBps = (-unrealisedPnlRaw * 10_000n) / costBasisRaw;
  return { shouldClose: true, reason: `STOP_LOSS: Liquidation value ${(Number(lossBps) / 100).toFixed(1)}% below cost` };
}

/** Legacy stop-loss rule for positions without shares: close once the price has moved 15% from entry. */
export function evaluateStopLoss(position: { entryPrice: number; currentPrice: number | null }): {
  shouldClose: boolean;
  reason?: string;
} {
  const currentPrice = position.currentPrice ?? position.entryPrice;
  const adverseMove = Math.abs(currentPrice - position.entryPrice) / position.entryPrice;

  if (adverseMove >= 0.15) {
    return { shouldClose: true, reason: `STOP_LOSS: Adverse move of ${(adverseMove * 100).toFixed(1)}%` };
  }

  return { shouldClose: false };
}

/**
 * Checks if the daily drawdown limit has been breached.
 * If yes, pauses new trade execution for DRAWDOWN_PAUSE_HOURS.
 */
export async function checkDailyDrawdown(bankroll: number): Promise<{
  isPaused:      boolean;
  drawdownPct:   number;
  pauseUntil?:   Date;
}> {
  const todayStart = utcStartOfDay();

  const todayTrades = await prisma.position.findMany({
    where: {
      status:   { in: ['CLOSED', 'STOP_LOSS'] },
      closedAt: { gte: todayStart },
    },
    select: { pnl: true },
  });

  const result = evaluateDailyDrawdown(todayTrades.map((t) => t.pnl), bankroll, new Date());
  if (result.isPaused) await recordDrawdownPause(result);
  return { isPaused: result.isPaused, drawdownPct: result.drawdownPct, pauseUntil: result.pauseUntil };
}

export interface DrawdownEvaluation {
  isPaused:    boolean;
  drawdownPct: number;
  dailyLoss:   number;
  pauseUntil?: Date;
}

/**
 * Pure drawdown rule over the P&L of positions closed today: the sum of the
 * losses (wins do not offset them) as a share of the bankroll.
 */
export function evaluateDailyDrawdown(closedPnl: number[], bankroll: number, now: Date): DrawdownEvaluation {
  const dailyLoss = closedPnl
    .filter(pnl => pnl < 0)
    .reduce((acc, pnl) => acc + Math.abs(pnl), 0);

  const drawdownPct = dailyLoss / bankroll;

  if (drawdownPct >= MAX_DAILY_DRAWDOWN_PCT) {
    return {
      isPaused: true,
      drawdownPct,
      dailyLoss,
      pauseUntil: new Date(now.getTime() + DRAWDOWN_PAUSE_HOURS * 60 * 60 * 1000),
    };
  }
  return { isPaused: false, drawdownPct, dailyLoss };
}

/**
 * Logs and persists a drawdown pause. The pause lives in agent_controls, so
 * the next cycle, a restart and every other instance see it (#79).
 */
export async function recordDrawdownPause(result: DrawdownEvaluation): Promise<void> {
  logger.warn({ drawdownPct: result.drawdownPct, pauseUntil: result.pauseUntil }, 'Daily drawdown limit reached — pausing agent');

  await pauseAgent('TRADER', {
    source: 'drawdown',
    actor: 'system',
    until: result.pauseUntil,
    reason: `Daily drawdown ${(result.drawdownPct * 100).toFixed(2)}% reached the ${(MAX_DAILY_DRAWDOWN_PCT * 100).toFixed(0)}% limit`,
  });

  await writeAgentLog({
    agentType: 'TRADER',
    level:     'WARN',
    action:    'DRAWDOWN_PAUSE',
    data:      { drawdownPct: result.drawdownPct, dailyLoss: result.dailyLoss, pauseUntil: result.pauseUntil?.toISOString() },
  });
}

// ─── Internal helper ───
async function findHedgeMarket(
  category: string,
  excludeMarketId: string,
  originalDirection: 'YES' | 'NO',
): Promise<any | null> {
  return prisma.market.findFirst({
    where: {
      category:      category as any,
      id:            { not: excludeMarketId },
      status:        'ACTIVE',
      totalLiquidity: { gte: 500 },
    },
    orderBy: { totalLiquidity: 'desc' },
  });
}