import { aggregateSignals } from '../services/ingestion.service';
import { calculateProbability } from '../services/market.service';
import { calculateKellySize, executeTrade } from '../services/trade.service';
import { exitPosition } from '../services/exit.service';
import { markOpenPositions } from '../services/valuation.service';
import { AgentPausedError, assertAgentActive, gateCycle } from '../services/agent-controls.service';
import { checkCorrelation } from '../services/correlation.service';
import { generateReasoningTrace } from '../services/reasoning.service';
import { detectHedgeOpportunities, autoHedge, checkDailyDrawdown, enforceStopLoss } from '../services/hedging.service';
import { prisma } from '../lib/prisma';
import { writeAgentLog } from '../lib/agent-log';
import { logger } from '../lib/logger';
import { config } from '../config';
import { deadline } from '../lib/resilience';
import { shutdownController } from '../lib/shutdown';
import { prodTraderEnv } from './trader-env';
import { DEFAULT_PARAMS, runTraderPolicy } from './trader-policy';

/**
 * Trader Agent — main execution loop.
 *
 * Called by the monitor cron every 15 minutes.
 *
 * Full flow:
 *   0. Gate on the persistent agent controls (kill switch, drawdown pause)
 *   1. Check daily drawdown — pause if limit hit
 *   1b. Mark open positions to market (FPMM liquidation value, #78)
 *   2. Stop-loss check; exits sell on-chain through treasury.agent_sell (#77)
 *   3. Check for hedge opportunities on deteriorating positions
 *   4. Scan active markets for +EV opportunities
 *   5. For each mispriced market: compute Kelly size, check correlation, execute
 *   6. Generate reasoning trace + pin to IPFS for each trade
 */
export async function runTraderCycle(opts?: { signal?: AbortSignal }): Promise<void> {
  logger.info('Trader Agent: starting cycle');

  try {
    await gateCycle('TRADER');
  } catch (err) {
    if (err instanceof AgentPausedError) {
      logger.info({ ...err.details }, 'Trader Agent: paused — skipping cycle');
      return;
    }
    throw err;
  }

  const parentSignal = opts?.signal
    ? opts.signal
    : shutdownController.signal;

  const handle = deadline('rpc-write', parentSignal, config.CYCLE_DEADLINE_MS);
  const signal = handle.signal;

  try {
    signal.throwIfAborted();

    // Step 1: Check daily drawdown limit. A breach persists a TRADER pause
    // (#79); the gate decides, not the return value.
    const drawdown = await checkDailyDrawdown(BANKROLL);
    try {
      await assertAgentActive('TRADER');
    } catch (err) {
      if (err instanceof AgentPausedError) {
        logger.warn({ drawdownPct: drawdown.drawdownPct, ...err.details }, 'Trader Agent: paused after drawdown check');
        return;
      }
      throw err;
    }

    signal.throwIfAborted();

    // Step 1b: Mark open positions to market so risk checks see real values
    await markOpenPositions();

    signal.throwIfAborted();

    // Step 2: Stop-loss on liquidation-based PnL
    const openPositions = await prisma.position.findMany({
      where: { status: 'OPEN' },
    });

    for (const position of openPositions) {
      signal.throwIfAborted();
      const { shouldClose, reason } = await enforceStopLoss(position.id);
      if (shouldClose && reason) {
        logger.info({ positionId: position.id, reason }, 'Stop-loss triggered');
        try {
          const exit = await exitPosition(position.id, { reason: 'STOP_LOSS' });
          logger.info({ positionId: position.id, exitStatus: exit.status, exitId: exit.exitId }, 'Stop-loss exit attempted');
        } catch (err) {
          logger.warn({ err, positionId: position.id }, 'Stop-loss exit failed');
        }
      }
    }

    signal.throwIfAborted();

    // Step 3: Hedge opportunities
    const hedgeRecs = await detectHedgeOpportunities();
    for (const rec of hedgeRecs) {
      signal.throwIfAborted();
      try {
        await autoHedge(rec);
      } catch (err) {
        logger.warn({ err, rec }, 'Trader Agent: hedge failed');
      }
    }

    signal.throwIfAborted();

    // Step 4: Scan markets for opportunities
    const signals = await aggregateSignals(signal);
    const activeMarkets = await prisma.market.findMany({
      where: {
        status:         'ACTIVE',
        totalLiquidity: { gte: MIN_MARKET_LIQUIDITY },
        expiryTimestamp: {
          gt:  new Date(),
          lte: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // Within 14 days
        },
      },
    });

    for (const market of activeMarkets) {
      signal.throwIfAborted();
      await analyzeAndTradeMarket(market, signals, signal);
    }

    logger.info('Trader Agent: cycle complete');
  } catch (err) {
    logger.error({ err }, 'Trader Agent: unhandled cycle error');
    await writeAgentLog({ agentType: 'TRADER', level: 'ERROR', action: 'CYCLE_FAILED', error: String(err) });
  } finally {
    handle.cleanup?.();
  }
}
