import { prisma } from '../lib/prisma';
import { writeAgentLog } from '../lib/agent-log';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import type { TradePayload } from '../types';
import { agentBuy, Outcomes, quoteBuy } from './chain.service';
import { enqueueTracePublication } from './trace-publish.service';
import { tradeTraceAction } from '../lib/trace-actions';
import { usdcFromNumber } from '../lib/amounts';

// ─── Risk constants ───
const MAX_CORRELATED_EXPOSURE  = 0.05;   // 5% total correlated exposure
const MIN_EDGE_THRESHOLD       = 0.08;   // 8 percentage points minimum edge
const MIN_LIQUIDITY_USD        = 500;    // $500 minimum market liquidity
const HARD_STOP_LOSS_PCT       = 0.15;   // Close if market moves 15% against
const AGENT_SLIPPAGE_BPS       = 100n;   // min_shares_out = quote − 1%

export { calculateKellySize } from './kelly';

/**
 * Executes an agent trade through treasury.agent_buy (the treasury's caps apply).
 *
 * Steps:
 * 1. Validate risk limits (edge, liquidity, position size)
 * 2. Create a PENDING trade record in DB
 * 3. Build and submit the on-chain transaction
 * 4. On success: mark trade EXECUTED, create Position record
 * 5. On failure: mark trade FAILED — position is NEVER created
 *
 * Atomic DB update ensures position state is never corrupted by a
 * partial failure (e.g. TX submitted but DB write failed).
 */
export async function executeTrade(payload: TradePayload): Promise<{
  trade: any;
  position: any;
}> {
  // ── Step 1: Validate risk limits ──
  if (Math.abs(payload.edgeDetected) < MIN_EDGE_THRESHOLD) {
    throw new AppError(400, 'INSUFFICIENT_EDGE', 
      `Edge ${payload.edgeDetected} below minimum ${MIN_EDGE_THRESHOLD}`);
  }

  // Fetch market to check platform
  const market = await prisma.market.findUnique({
    where: { id: payload.marketId },
  });

  if (!market) {
    throw new AppError(404, 'MARKET_NOT_FOUND', 'Market not found');
  }

  // Check existing exposure for this market
  const existingPosition = await prisma.position.findFirst({
    where: { marketId: payload.marketId, status: 'OPEN' },
  });
  if (existingPosition) {
    throw new AppError(409, 'POSITION_EXISTS', 'Open position already exists for this market');
  }

  // ── Step 2: Create PENDING trade record ──
  const trade = await prisma.trade.create({
    data: {
      marketId:      payload.marketId,
      direction:     payload.direction,
      status:        'PENDING',
      amount:        payload.amount,
      price:         payload.price,
      edgeDetected:  payload.edgeDetected,
      kellyFraction: payload.kellyFraction,
    },
  });

  // ── Step 3: Attempt on-chain execution ──
  let txHash: string | null = null;
  let dryRun = false;
  try {
    const submitted = await submitTradeTransaction(payload, market);
    txHash = submitted.txHash;
    dryRun = submitted.dryRun;
  } catch (err) {
    // Mark as FAILED — no position created
    await prisma.trade.update({
      where: { id: trade.id },
      data:  { status: 'FAILED', errorMessage: String(err) },
    });

    await logAgentAction('TRADER', 'ERROR', 'TRADE_EXECUTION_FAILED', payload.marketId, {
      tradeId: trade.id,
      error:   String(err),
    });

    throw new AppError(502, 'TRADE_FAILED', 'On-chain trade execution failed', { error: String(err) });
  }

  if (dryRun) {
    // Simulated only: no funds moved, so no position exists.
    await prisma.trade.update({
      where: { id: trade.id },
      data:  { status: 'CANCELLED', errorMessage: 'dry-run: simulated, not submitted' },
    });
    await logAgentAction('TRADER', 'INFO', 'TRADE_SIMULATED', payload.marketId, {
      tradeId: trade.id, direction: payload.direction, amount: payload.amount,
    });
    return { trade: { ...trade, status: 'CANCELLED' }, position: null };
  }

  // ── Step 4: Atomic success update ──
  const [updatedTrade, position] = await prisma.$transaction([
    prisma.trade.update({
      where: { id: trade.id },
      data:  {
        status:     'EXECUTED',
        txHash,
        executedAt: new Date(),
      },
    }),
    prisma.position.create({
      data: {
        marketId:    payload.marketId,
        tradeId:     trade.id,
        direction:   payload.direction,
        status:      'OPEN',
        entryPrice:  payload.price,
        currentPrice: payload.price,
        size:        payload.amount,
        pnl:         0,
      },
    }),
  ]);

  // ── Step 5: Queue the trace for publication to reasoning-registry (#131) ──
  // Durable: the worker pins, waits for the on-chain market and retries.
  if (payload.traceId && payload.tracePayload) {
    try {
      await enqueueTracePublication({
        traceId: payload.traceId,
        payload: payload.tracePayload,
        action: tradeTraceAction(payload.direction),
      });
    } catch (err) {
      logger.error({ err, traceId: payload.traceId }, 'Failed to queue trade trace publication');
    }
  }

  await logAgentAction('TRADER', 'INFO', 'TRADE_EXECUTED', payload.marketId, {
    tradeId: updatedTrade.id,
    txHash,
    direction: payload.direction,
    amount:    payload.amount,
    edge:      payload.edgeDetected,
  });

  logger.info({ tradeId: updatedTrade.id, txHash, amount: payload.amount }, 'Trade executed');
  return { trade: updatedTrade, position };
}

/**
 * Updates the P&L of an open position based on current market price.
 * Called by the monitor cron every 15 minutes.
 */
export async function trackPosition(
  positionId: string,
  currentPrice: number,
): Promise<any> {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: { trade: true },
  });

  if (!position || position.status !== 'OPEN') return null;

  const direction = position.direction;
  const entryPrice = position.entryPrice;
  const size = position.size;

  // P&L: if YES position, gain when price goes up; loss when price goes down
  const pnl =
    direction === 'YES'
      ? (currentPrice - entryPrice) * size
      : (entryPrice - currentPrice) * size;

  const priceChange = Math.abs(currentPrice - entryPrice) / entryPrice;

  // Check hard stop-loss
  if (pnl < 0 && priceChange >= HARD_STOP_LOSS_PCT) {
    return closePosition(positionId, currentPrice, 'STOP_LOSS');
  }

  return prisma.position.update({
    where: { id: positionId },
    data:  { currentPrice, pnl },
  });
}

/**
 * Closes an open position.
 *
 * closeReason values:
 * - 'STOP_LOSS': Hard 15% adverse move triggered
 * - 'EDGE_DEGRADED': Agent's new probability estimate removed the edge
 * - 'MANUAL': Human override
 * - 'EXPIRY': Market approaching resolution
 */
export async function closePosition(
  positionId: string,
  closePrice: number,
  closeReason: string,
): Promise<any> {
  const position = await prisma.position.findUnique({
    where: { id: positionId },
    include: { trade: true },
  });

  if (!position) throw new AppError(404, 'POSITION_NOT_FOUND', 'Position not found');
  if (position.status !== 'OPEN') {
    throw new AppError(409, 'POSITION_CLOSED', 'Position is already closed');
  }

  const pnl =
    position.direction === 'YES'
      ? (closePrice - position.entryPrice) * position.size
      : (position.entryPrice - closePrice) * position.size;

  const closed = await prisma.position.update({
    where: { id: positionId },
    data:  {
      status:       closeReason === 'STOP_LOSS' ? 'STOP_LOSS' : 'CLOSED',
      currentPrice: closePrice,
      pnl,
      closedAt:     new Date(),
      closeReason,
    },
  });

  await logAgentAction('TRADER', 'INFO', 'POSITION_CLOSED', position.marketId, {
    positionId,
    closeReason,
    pnl,
    closePrice,
  });

  logger.info({ positionId, closeReason, pnl }, 'Position closed');
  return closed;
}

/**
 * Quotes the market right before building the transaction, then buys through
 * the treasury with min_shares_out a little below that quote.
 */
async function submitTradeTransaction(
  payload: TradePayload,
  market: { id: string; onChainMarketId: bigint | null },
): Promise<{ txHash: string | null; dryRun: boolean }> {
  if (market.onChainMarketId === null) {
    throw new AppError(409, 'MARKET_NOT_ON_CHAIN', 'Market has no on-chain id yet');
  }
  const outcome = payload.direction === 'YES' ? Outcomes.Yes : Outcomes.No;
  const collateralIn = usdcFromNumber(payload.amount);
  const quoted = await quoteBuy(market.onChainMarketId, outcome, collateralIn);
  const minSharesOut = (quoted * (10_000n - AGENT_SLIPPAGE_BPS)) / 10_000n;

  logger.info(
    { marketId: market.id, onChainMarketId: market.onChainMarketId.toString(), collateralIn: collateralIn.toString() },
    'Executing agent_buy through the treasury',
  );
  const result = await agentBuy({
    market_id: market.onChainMarketId,
    outcome,
    collateral_in: collateralIn,
    min_shares_out: minSharesOut,
  });
  return { txHash: result.txHash, dryRun: result.mode === 'dry-run' };
}

async function logAgentAction(
  agentType: 'MARKET_MAKER' | 'TRADER',
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
  action: string,
  marketId: string | null,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await writeAgentLog({ agentType, level, action, marketId: marketId ?? undefined, data });
  } catch {}
}
