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

const BANKROLL = 10_000;  // $10,000 USDC starting bankroll
const MIN_MARKET_LIQUIDITY = 500;
const MIN_EDGE = 0.08;

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

async function analyzeAndTradeMarket(market: any, signals: any, signal?: AbortSignal): Promise<void> {
  try {
    // Skip if we already have an open position in this market
    const existingPosition = await prisma.position.findFirst({
      where: { marketId: market.id, status: 'OPEN' },
    });
    if (existingPosition) return;

    // Estimate probability using signal weighting
    const marketProb = market.currentYesProb ?? market.initialYesProb;
    const sourceSignals = signals.news.slice(0, 3).map((s: any) => ({
      source:   s.source,
      weight:   0.7,
      signal:   s.title,
      rawValue: marketProb,
    }));

    const { probability: agentProb, confidenceInterval } = calculateProbability(
      sourceSignals,
      marketProb,
    );

    // Compute edge
    const edge = agentProb - marketProb;

    // Guard: insufficient edge
    if (Math.abs(edge) < MIN_EDGE) return;

    // Kelly sizing — use conservative end of CI
    const conservativeProb = edge > 0 ? confidenceInterval.lower : 1 - confidenceInterval.upper;
    const kellyResult = calculateKellySize({
      agentProbability:  Math.max(0.01, conservativeProb),
      marketProbability: marketProb,
      bankroll:          BANKROLL,
      netOdds:           edge > 0 ? (1 - marketProb) / marketProb : marketProb / (1 - marketProb),
    });

    if (kellyResult.betSize <= 0) return;

    // Correlation check — may reduce position size
    const correlation = await checkCorrelation(market.id, kellyResult.betSize, BANKROLL);
    const finalSize = correlation.adjustedPositionSize;

    if (finalSize < 1) {
      logger.debug({ marketId: market.id }, 'Position size too small after correlation adjustment — skipping');
      return;
    }

    const direction = edge > 0 ? 'YES' : 'NO';
    const price     = direction === 'YES' ? marketProb : 1 - marketProb;

    signal?.throwIfAborted();

    // Generate reasoning trace BEFORE executing
    const { trace, tracePayload } = await generateReasoningTrace({
      marketId:            market.id,
      agentType:           'TRADER',
      decisionType:        'OPEN_POSITION',
      sourcesUsed:         sourceSignals,
      probabilityEstimate: agentProb,
      marketProbability:   marketProb,
      edge,
      confidenceInterval,
      betFraction:         kellyResult.halfKelly,
      betSizeUsdc:         finalSize,
    });

    // Execute trade (Never abort between chain write and DB update)
    await executeTrade({
      marketId:      market.id,
      direction,
      amount:        finalSize,
      price,
      kellyFraction: kellyResult.halfKelly,
      edgeDetected:  edge,
      traceId:       trace.id,
      tracePayload,
    });

    logger.info({ marketId: market.id, direction, amount: finalSize, edge }, 'Trader Agent: trade executed');
  } catch (err) {
    logger.warn({ err, marketId: market.id }, 'Trader Agent: market analysis failed');
  }
}