import { prisma } from '../lib/prisma';
import { writeAgentLog } from '../lib/agent-log';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { AgentPausedError } from './agent-controls.service';
import type { KellyResult, TradePayload, KellyInput } from '../types';
import { agentBuy, getOnChainMarket, Outcomes, quoteBuy, ExpiredError } from './chain.service';
import { ChainPendingError, TransactionError } from './stellar/errors';

/** Collateral in base units: amountRaw when the trader sized in base units (#76), else the display amount. */
const collateralOf = (payload: TradePayload): bigint => payload.amountRaw ?? usdcFromNumber(payload.amount);
import { isPermanentFailure } from './stellar/failures';
import { registerHandler, type ChainTransactionRow, type CompletionOutcome } from './stellar/outbox';
import { Prisma } from '@prisma/client';
import { enqueueTracePublication } from './trace-publish.service';
import { tradeTraceAction } from '../lib/trace-actions';
import { bigintToDecimalString, mulDivCeil, usdcFromNumber } from '../lib/amounts';
import { config } from '../config';
import { TREASURY_CAP_ERRORS } from './treasury-budget.service';
import { ChainError } from './stellar/errors';

// ─── Risk constants ───
const MAX_CORRELATED_EXPOSURE  = 0.05;   // 5% total correlated exposure
const MIN_EDGE_THRESHOLD       = 0.08;   // 8 percentage points minimum edge
const MIN_LIQUIDITY_USD        = 500;    // $500 minimum market liquidity
const AGENT_SLIPPAGE_BPS       = 100n;   // min_shares_out = quote − 1%

export { calculateKellySize } from './kelly';

/**
 * Applies a confirmed buy exactly once (#35): Trade → EXECUTED guarded on
 * PENDING, Position created under its unique tradeId (a P2002 means a
 * previous run already created it). Shared by the trade.buy completion
 * handler (inline and crash recovery) and executeTrade's direct path.
 */
export async function applyBuySuccess(
  tradeId: string,
  fill: { sharesOut: bigint; collateralIn: bigint; feeRaw: bigint; txHash: string | null; innerTxHash: string | null },
): Promise<void> {
  const trade = await prisma.trade.findUnique({ where: { id: tradeId }, select: { id: true, marketId: true, direction: true, amount: true } });
  if (!trade) return;

  const effectivePrice = fill.sharesOut > 0n ? Math.min(1, Number(fill.collateralIn) / Number(fill.sharesOut)) : 0;

  await prisma.trade.updateMany({
    where: { id: tradeId, status: { in: ['PENDING'] } },
    data: {
      status: 'EXECUTED',
      txHash: fill.txHash,
      innerTxHash: fill.innerTxHash ?? fill.txHash,
      executedAt: new Date(),
    },
  });
  try {
    await prisma.position.create({
      data: {
        marketId: trade.marketId,
        tradeId: trade.id,
        direction: trade.direction,
        status: 'OPEN',
        entryPrice: effectivePrice,
        currentPrice: effectivePrice,
        size: trade.amount,
        pnl: 0,
        sharesRaw: bigintToDecimalString(fill.sharesOut),
        costBasisRaw: bigintToDecimalString(fill.collateralIn),
        feesPaidRaw: bigintToDecimalString(fill.feeRaw),
      },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
}

/**
 * Completion handler for `trade.buy` outbox rows (#35), whether confirmation
 * arrived inline or from the recovery worker after a crash. Idempotent.
 */
export async function handleTradeBuyOutcome(row: ChainTransactionRow, outcome: CompletionOutcome): Promise<void> {
  const tradeId = row.refId;
  if (!tradeId) return;

  if (outcome.status !== 'SUCCESS') {
    // EXPIRED rows the worker resolves were abandoned mid-rebuild or after a
    // crash: the envelope never landed, so the trade definitively failed.
    await prisma.trade.updateMany({
      where: { id: tradeId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        errorMessage: outcome.status === 'EXPIRED' ? 'expired unsubmitted' : (outcome.error ?? 'failed on-chain'),
      },
    });
    return;
  }

  const args = (row.args ?? {}) as { collateral_in?: string; feeRaw?: string };
  await applyBuySuccess(tradeId, {
    sharesOut: BigInt(String(outcome.value ?? '0')),
    collateralIn: BigInt(args.collateral_in ?? '0'),
    feeRaw: BigInt(args.feeRaw ?? '0'),
    txHash: outcome.txHash ?? null,
    innerTxHash: row.hash,
  });
}

registerHandler('trade.buy', handleTradeBuyOutcome);

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

  // ── Step 3: Attempt on-chain execution with safe rebuild on EXPIRED ──
  let txHash: string | null = null;
  let dryRun = false;
  let fill: Pick<SubmittedTrade, 'sharesOut' | 'collateralIn' | 'feeRaw'> | null = null;
  let rebuildAttempt = 0;
  let prevTxHash: string | null = null;

  while (true) {
    try {
      const submitted = await submitTradeTransaction(payload, market, trade.id, rebuildAttempt);
      txHash = submitted.txHash;
      dryRun = submitted.dryRun;
      fill = submitted;
      break;
    } catch (err: any) {
      // Submitted but unconfirmed (#35): the outbox row owns resolution. The
      // trade stays PENDING; the trade.buy handler finishes it either way.
      if (err instanceof ChainPendingError) {
        await prisma.trade.update({
          where: { id: trade.id },
          data: { errorMessage: `awaiting confirmation ${err.txHash ?? ''}`.trim() },
        });
        await logAgentAction('TRADER', 'WARN', 'TRADE_PENDING_CONFIRMATION', payload.marketId, {
          tradeId: trade.id,
          txHash: err.txHash,
          outboxId: err.outboxId,
        });
        return { trade: { ...trade, status: 'PENDING' }, position: null };
      }

      // A paused agent is not a failed trade: nothing was sent (#79).
      if (err instanceof AgentPausedError) {
        await prisma.trade.update({
          where: { id: trade.id },
          data:  { status: 'CANCELLED', errorMessage: `${err.code}: ${err.message}` },
        });
        await logAgentAction('TRADER', 'INFO', 'TRADE_SKIPPED_PAUSED', payload.marketId, { tradeId: trade.id });
        throw err;
      }

      // Safe rebuild if expired and within MAX_REBUILD_COUNT
      const isExpired = err instanceof ExpiredError || err?.code === 'CHAIN_TX_EXPIRED' || /expired/i.test(err?.message ?? '');
      if (isExpired && rebuildAttempt < config.MAX_REBUILD_COUNT) {
        rebuildAttempt++;
        prevTxHash = err?.txHash ?? txHash;
        logger.info(
          { marketId: payload.marketId, tradeId: trade.id, rebuildAttempt, prevTxHash },
          'Trade transaction expired; re-quoting and checking edge before rebuild',
        );

        // Re-quote market to verify edge
        const outcome = payload.direction === 'YES' ? Outcomes.Yes : Outcomes.No;
        const collateralIn = collateralOf(payload);
        const freshQuoted = await quoteBuy(market.onChainMarketId!, outcome, collateralIn);
        const freshPrice = Math.min(1, Number(collateralIn) / Number(freshQuoted));
        const freshEdge = Math.abs(payload.price - freshPrice);

        if (freshEdge < MIN_EDGE_THRESHOLD) {
          logger.warn(
            { marketId: payload.marketId, freshEdge, threshold: MIN_EDGE_THRESHOLD },
            'Fresh price removes edge; aborting rebuild',
          );
          await prisma.trade.update({
            where: { id: trade.id },
            data:  { status: 'CANCELLED', errorMessage: `EDGE_DEGRADED: fresh edge ${freshEdge} below minimum ${MIN_EDGE_THRESHOLD}` },
          });
          await logAgentAction('TRADER', 'WARN', 'TRADE_REBUILD_EDGE_LOST', payload.marketId, {
            tradeId: trade.id,
            freshEdge,
            rebuildAttempt,
          });
          throw new AppError(400, 'INSUFFICIENT_EDGE', `Edge degraded on re-quote (${freshEdge} < ${MIN_EDGE_THRESHOLD})`);
        }

        // Edge holds; resubmit linked to old attempt
        await logAgentAction('TRADER', 'INFO', 'TRADE_REBUILD_ATTEMPT', payload.marketId, {
          tradeId: trade.id,
          rebuildAttempt,
          prevTxHash,
        });
        continue;
      }

      // #40: only a permanent classification marks the trade FAILED. A retryable
      // failure that exhausted its attempts, and an ambiguous outcome (the
      // transaction may have been applied), are left PENDING for a later retry or
      // reconciliation instead of being recorded as a definite failure.
      const failure = err instanceof TransactionError
        ? (err.details as { failureClass?: string } | undefined)?.failureClass
        : null;
      const permanent = failure ? isPermanentFailure(failure as any) : !(err instanceof TransactionError);

      // The treasury refused the spend on a cap (#76): the budget estimate and
      // the chain disagreed. Logged with the snapshot the size came from.
      const contractError = err instanceof ChainError ? err.contractError : null;
      if (contractError && TREASURY_CAP_ERRORS.has(contractError)) {
        await logAgentAction('TRADER', 'WARN', 'TREASURY_CAP_REJECTED', payload.marketId, {
          tradeId: trade.id,
          contractError,
          amountRaw: collateralOf(payload).toString(),
          budget: payload.budget ?? null,
        });
      }

      if (permanent) {
        await prisma.trade.update({
          where: { id: trade.id },
          data:  { status: 'FAILED', errorMessage: String(err) },
        });
        await logAgentAction('TRADER', 'ERROR', 'TRADE_EXECUTION_FAILED', payload.marketId, {
          tradeId: trade.id,
          error:   String(err),
        });
      } else {
        await prisma.trade.update({
          where: { id: trade.id },
          data:  { errorMessage: String(err) },
        });
        await logAgentAction('TRADER', 'WARN', 'TRADE_DEFERRED', payload.marketId, {
          tradeId: trade.id,
          failureClass: failure,
          error:   String(err),
        });
      }

      throw new AppError(502, 'TRADE_FAILED', 'On-chain trade execution failed', { error: String(err), failureClass: failure });
    }
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

  // ── Step 4: Apply the confirmed buy (idempotent, shared with recovery) ──
  // #35: the trade.buy completion handler normally applied this before
  // agentBuy resolved; applyBuySuccess is guarded (PENDING CAS, unique
  // tradeId), so this direct call is a no-op when it did and the single
  // writer when it could not run (e.g. injected chain deps).
  const { sharesOut, collateralIn, feeRaw } = fill!;
  await applyBuySuccess(trade.id, { sharesOut, collateralIn, feeRaw, txHash, innerTxHash: txHash });
  const updatedTrade = await prisma.trade.findUnique({ where: { id: trade.id } });
  const position = await prisma.position.findUnique({ where: { tradeId: trade.id } });
  if (!updatedTrade || updatedTrade.status !== 'EXECUTED' || !position) {
    logger.warn({ tradeId: trade.id, txHash }, 'Trade confirmed on-chain; completion pending recovery');
    return { trade: updatedTrade ?? trade, position: position ?? null };
  }

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
 * Closes an open position in the database only. It does NOT touch the chain:
 * the treasury keeps its shares. Use it for closes that need no sale (market
 * resolution, manual bookkeeping); exits that must sell go through
 * `exitPosition()` in exit.service.ts (treasury.agent_sell).
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

export interface SubmittedTrade {
  txHash: string | null;
  dryRun: boolean;
  /** Shares agent_buy returned (i128 base units). */
  sharesOut: bigint;
  collateralIn: bigint;
  /** Fee paid on the buy, rounded up like market-core. */
  feeRaw: bigint;
}

/**
 * Quotes the market right before building the transaction, then buys through
 * the treasury with min_shares_out a little below that quote.
 */
async function submitTradeTransaction(
  payload: TradePayload,
  market: { id: string; onChainMarketId: bigint | null },
  attemptId?: string,
  rebuildCount = 0,
): Promise<SubmittedTrade> {
  if (market.onChainMarketId === null) {
    throw new AppError(409, 'MARKET_NOT_ON_CHAIN', 'Market has no on-chain id yet');
  }
  const outcome = payload.direction === 'YES' ? Outcomes.Yes : Outcomes.No;
  // No float round trip when the trader sized in base units (#76).
  const collateralIn = collateralOf(payload);
  // fee_bps is fixed at market creation; the fee is charged on collateral in.
  const onChain = await getOnChainMarket(market.onChainMarketId);
  const feeRaw = mulDivCeil(collateralIn, BigInt(onChain.fee_bps), 10_000n);

  logger.info(
    {
      marketId: market.id,
      onChainMarketId: market.onChainMarketId.toString(),
      collateralIn: collateralIn.toString(),
      attemptId,
      rebuildCount,
    },
    'Executing agent_buy through the treasury',
  );
  // The min_shares_out bound is recomputed from a fresh quote on every attempt,
  // so a retry never reuses a bound that a moved price has invalidated (#40).
  // attemptId and rebuildCount tag the submission for idempotency tracking
  // (#41/#42); feeRaw rides along so the trade.buy completion handler can
  // record the position's fees without re-reading the chain (#35).
  const result = await agentBuy(
    async () => {
      const quoted = await quoteBuy(market.onChainMarketId!, outcome, collateralIn);
      const minSharesOut = (quoted * (10_000n - AGENT_SLIPPAGE_BPS)) / 10_000n;
      return {
        market_id: market.onChainMarketId!,
        outcome,
        collateral_in: collateralIn,
        min_shares_out: minSharesOut,
      };
    },
    undefined,
    {
      collateral_in: collateralIn.toString(),
      feeRaw: feeRaw.toString(),
      ...(attemptId ? { attemptId } : {}),
      ...(rebuildCount ? { rebuildCount } : {}),
    },
    attemptId ? { kind: 'trade.buy', refId: attemptId } : undefined,
  );
  return {
    txHash: result.txHash,
    dryRun: result.mode === 'dry-run',
    sharesOut: result.value,
    collateralIn,
    feeRaw,
  };
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
