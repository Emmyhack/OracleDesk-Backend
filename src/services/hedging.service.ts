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
const STOP_LOSS_BPS             = 1_500n; // Exit at a 15% liquidation-value loss
const HEDGE_LOSS_BPS            = 1_000n; // Hedge at a 10% liquidation-value loss

/**
 * Unrealised loss as basis points of cost, from the mark-to-market columns
 * (#78): liquidation value minus cost, i.e. what selling now would lose.
 * Null for legacy rows that were never given shares.
 */
function liquidationLossBps(position: { costBasisRaw: any; unrealisedPnlRaw: any }): bigint | null {
  if (position.costBasisRaw == null || position.unrealisedPnlRaw == null) return null;
  const cost = decimalToBigint(position.costBasisRaw);
  if (cost <= 0n) return null;
  return (-decimalToBigint(position.unrealisedPnlRaw) * 10_000n) / cost;
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
 * 2. OR selling the position now would realise a loss of 10% or more of its
 *    cost (liquidation value, #78; legacy rows without shares fall back to
 *    the float pnl)
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
    const lossBps = liquidationLossBps(position);
    const hasLoss = lossBps !== null
      ? lossBps >= HEDGE_LOSS_BPS
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
 * Called by the trader cycle every 15 minutes, after markOpenPositions().
 * Flags positions whose liquidation value is 15% or more below their cost.
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

  // Liquidation-based (#78): what the shares would fetch if sold now against
  // the pool, not the mid price. Written by markOpenPositions() each cycle.
  const lossBps = liquidationLossBps(position);
  if (lossBps !== null) {
    if (lossBps >= STOP_LOSS_BPS) {
      return { shouldClose: true, reason: `STOP_LOSS: Liquidation value is ${(Number(lossBps) / 100).toFixed(1)}% below cost` };
    }
    return { shouldClose: false };
  }

  // Legacy rows (no shares recorded) keep the old price-move rule.
  const currentPrice = position.currentPrice ?? position.entryPrice;
  const adverseMove = Math.abs(currentPrice - position.entryPrice) / position.entryPrice;

  if (adverseMove >= 0.15) {
    return { shouldClose: true, reason: `STOP_LOSS: Adverse move of ${(adverseMove * 100).toFixed(1)}%` };
  }

  return { shouldClose: false };
}

/**
 * Checks if the daily drawdown limit has been breached.
 * If yes, persists a TRADER pause for DRAWDOWN_PAUSE_HOURS (#79); every
 * instance sees it, and the cycle gate (assertAgentActive) enforces it.
 *
 * "Today" is the UTC day (it used to be the server's local day, which differed
 * between instances).
 */
export async function checkDailyDrawdown(bankroll: number): Promise<{
  isPaused:      boolean;
  drawdownPct:   number;
  pauseUntil?:   Date;
}> {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

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
    const pauseUntil = new Date(Date.now() + DRAWDOWN_PAUSE_HOURS * 60 * 60 * 1000);
    logger.warn({ drawdownPct, pauseUntil }, 'Daily drawdown limit reached — pausing agent');

    await pauseAgent('TRADER', {
      source: 'drawdown',
      actor: 'system',
      until: pauseUntil,
      reason: `Daily drawdown ${(drawdownPct * 100).toFixed(2)}% reached the ${(MAX_DAILY_DRAWDOWN_PCT * 100).toFixed(0)}% limit`,
    });

    await writeAgentLog({
      agentType: 'TRADER',
      level:     'WARN',
      action:    'DRAWDOWN_PAUSE',
      data:      { drawdownPct, dailyLoss, pauseUntil: pauseUntil.toISOString() },
    });

    return { isPaused: true, drawdownPct, pauseUntil };
  }
  return { isPaused: false, drawdownPct, dailyLoss };
}

/** Logs and records a drawdown pause. */
export async function recordDrawdownPause(result: DrawdownEvaluation): Promise<void> {
  logger.warn({ drawdownPct: result.drawdownPct, pauseUntil: result.pauseUntil }, 'Daily drawdown limit reached — pausing agent');

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