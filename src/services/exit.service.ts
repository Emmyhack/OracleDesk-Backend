/**
 * On-chain position exits through treasury.agent_sell (#77).
 *
 * market-core's `sell` takes an exact `collateral_out` and burns however many
 * shares that needs (reverting with SlippageExceeded above `max_shares_in`, or
 * InsufficientShares if the holder has too few). To sell "N shares" we invert
 * the FPMM off-chain (`collateralOutForShares`, rounded down), verify with
 * `calcSell`, and bound the share spend with `max_shares_in`.
 *
 * The holder of agent positions is the treasury contract, not the agent key,
 * so balances are read for `CONTRACTS.treasury`. A position changes only from
 * a confirmed live result; dry-run exits are recorded as SIMULATED. Every
 * attempt writes a PositionExit row. An exit whose submission outcome is
 * unknown stays SUBMITTED and blocks new exits for that position until the
 * next call reconciles it against the on-chain balance, so it never sells twice.
 */
import { nowMs } from '../lib/clock';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { writeAgentLog } from '../lib/agent-log';
import { AppError } from '../middlewares/error.middleware';
import { CONTRACTS } from '../config/contracts';
import {
  bigintToDecimalString,
  decimalToBigint,
  toDisplayUsdc,
  usdcFromNumber,
} from '../lib/amounts';
import { MathError, calcSell, collateralOutForShares } from '../generated/fpmm';
import type { Market as OnChainMarket } from '../generated/market-core';
import {
  Outcomes,
  agentSell,
  getOnChainMarket,
  getPosition,
  quoteSell,
} from './chain.service';
import { ChainError, ChainPendingError } from './stellar/errors';
import { registerHandler, type ChainTransactionRow, type CompletionOutcome } from './stellar/outbox';
import { AgentPausedError } from './agent-controls.service';

/** Remaining shares at or below this are dust: the position counts as closed. */
export const DUST_SHARES = 1_000n;
export const EXIT_SLIPPAGE_BPS = 100n;
/** Exits planned this close to close_time race with trading stopping; leave them to settlement. */
export const EXIT_CLOSE_GUARD_MS = 60_000;
const MAX_VERIFY_STEPS = 16;
const MAX_HALVINGS = 4;
const MAX_SLIPPAGE_RETRIES = 2;
const MAX_INSUFFICIENT_RETRIES = 1;

type Outcome = 'YES' | 'NO';

export class ExitError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(409, code, message, details);
    this.name = 'ExitError';
  }
}

export interface ExitPlan {
  sharesTarget: bigint;
  collateralOut: bigint;
  quotedSharesIn: bigint;
  maxSharesIn: bigint;
}

/**
 * Plans a sale of `sharesTarget` shares against the pool in `m`.
 *
 * `collateralOutForShares` ignores integer rounding, so the result is checked
 * with `calcSell` and lowered one unit at a time until the shares it burns fit
 * the target (bounded). A pool that can't absorb the target halves it (at most
 * 4 times) before giving up with EXIT_ILLIQUID; the plan's `sharesTarget` is
 * the reduced amount. `max_shares_in` never exceeds `sharesHeld`.
 */
export function planExit(
  m: Pick<OnChainMarket, 'reserve_yes' | 'reserve_no' | 'fee_bps'>,
  outcome: Outcome,
  sharesTarget: bigint,
  slippageBps: bigint,
  sharesHeld: bigint = sharesTarget,
): ExitPlan {
  const [rSold, rOther] = outcome === 'YES'
    ? [BigInt(m.reserve_yes), BigInt(m.reserve_no)]
    : [BigInt(m.reserve_no), BigInt(m.reserve_yes)];
  const feeBps = BigInt(m.fee_bps);

  let target = sharesTarget < sharesHeld ? sharesTarget : sharesHeld;
  for (let halvings = 0; halvings <= MAX_HALVINGS && target > 0n; halvings++) {
    try {
      let collateralOut = collateralOutForShares(rSold, rOther, target, feeBps);
      for (let step = 0; step < MAX_VERIFY_STEPS; step++) {
        if (collateralOut <= 0n) throw new MathError('invalid input');
        const sale = calcSell(rSold, rOther, collateralOut, feeBps);
        if (sale.sharesIn <= target) {
          const padded = (target * (10_000n + slippageBps)) / 10_000n;
          const maxSharesIn = padded < sharesHeld ? padded : sharesHeld;
          return { sharesTarget: target, collateralOut, quotedSharesIn: sale.sharesIn, maxSharesIn };
        }
        collateralOut -= 1n;
      }
      throw new ExitError('EXIT_PLAN_UNVERIFIED', 'Could not find a collateral_out that sells within the target shares');
    } catch (err) {
      if (!(err instanceof MathError)) throw err;
      target /= 2n;
    }
  }
  throw new ExitError('EXIT_ILLIQUID', 'The pool cannot absorb this sale', {
    sharesTarget: sharesTarget.toString(),
  });
}

// ─── Exit execution ──────────────────────────────────────────────────────────

export interface ExitResult {
  exitId: string | null;
  status: 'CONFIRMED' | 'FAILED' | 'SIMULATED' | 'SUBMITTED';
  /** Reason code for FAILED / pending exits, e.g. EXIT_MARKET_CLOSED. */
  code?: string;
  sharesSoldRaw: bigint;
  collateralOutRaw: bigint;
  /** The position is closed after this exit. */
  closed: boolean;
}

interface LoadedPosition {
  id: string;
  marketId: string;
  direction: Outcome;
  status: string;
  size: number;
  sharesRaw: any;
  costBasisRaw: any;
  realisedCollateralRaw: any;
  realisedPnlRaw: any;
  trade: { amount: number } | null;
  market: { id: string; onChainMarketId: bigint | null; expiryTimestamp: Date };
}

const loadPosition = (id: string) =>
  prisma.position.findUnique({
    where: { id },
    include: { trade: { select: { amount: true } }, market: { select: { id: true, onChainMarketId: true, expiryTimestamp: true } } },
  }) as unknown as Promise<LoadedPosition | null>;

const outcomeValue = (o: Outcome) => (o === 'YES' ? Outcomes.Yes : Outcomes.No);

async function chainHeld(onChainMarketId: bigint, outcome: Outcome): Promise<bigint> {
  const held = await getPosition(onChainMarketId, CONTRACTS.treasury);
  return BigInt(outcome === 'YES' ? held.yes : held.no);
}

type Failure = 'slippage' | 'insufficient' | 'closed' | 'paused' | 'agent-paused' | 'ambiguous' | 'other';

function classify(err: unknown): Failure {
  if (err instanceof AgentPausedError) return 'agent-paused';
  // Submitted but unconfirmed within the inline wait (#35): the outbox worker
  // resolves it; the exit stays SUBMITTED until then.
  if (err instanceof ChainPendingError) return 'ambiguous';
  if (err instanceof ChainError) {
    switch (err.contractError) {
      case 'SlippageExceeded': return 'slippage';
      case 'InsufficientShares': return 'insufficient';
      case 'MarketClosed':
      case 'MarketNotOpen': return 'closed';
      case 'Paused': return 'paused';
    }
    // The submission may or may not have landed. #40 reports this as a
    // TransactionError with failureClass UNKNOWN_OUTCOME / submitted=true.
    if (err.code === 'CHAIN_SUBMISSION_TIMEOUT') return 'ambiguous';
    if ((err.details as { failureClass?: string } | undefined)?.failureClass === 'UNKNOWN_OUTCOME') return 'ambiguous';
    if (err.contractError === null && /submission failed/.test(err.message)) return 'ambiguous';
  }
  return 'other';
}

const FAILURE_CODES: Record<Exclude<Failure, 'ambiguous'>, string> = {
  slippage: 'EXIT_SLIPPAGE',
  insufficient: 'EXIT_INSUFFICIENT_SHARES',
  closed: 'EXIT_MARKET_CLOSED',
  paused: 'EXIT_PAUSED',
  'agent-paused': 'AGENT_PAUSED',
  other: 'EXIT_FAILED',
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function recordFailure(
  positionId: string,
  p: { mode: string; reason: string; code: string; error?: string; collateralOut?: bigint; maxSharesIn?: bigint },
) {
  return prisma.positionExit.create({
    data: {
      positionId,
      mode: p.mode,
      reason: p.reason,
      status: 'FAILED',
      error: [p.code, p.error].filter(Boolean).join(': '),
      collateralOutRaw: bigintToDecimalString(p.collateralOut ?? 0n),
      maxSharesInRaw: bigintToDecimalString(p.maxSharesIn ?? 0n),
    },
  });
}

/**
 * Applies a confirmed (or reconciled) sale to the position and the exit row in
 * one transaction. Cost basis is released pro rata; a full exit releases it all.
 */
/**
 * Applies a confirmed exit exactly once (#35): the CONFIRMED transition is a
 * compare-and-set on the exit row's SUBMITTED status inside one transaction
 * with the position update, so the trade.sell completion handler (inline or
 * crash recovery) and exitPosition's direct path can both call it safely —
 * whoever wins the CAS applies the position deltas, the loser reads back.
 */
async function applyConfirmedExit(
  position: LoadedPosition,
  exitId: string,
  p: { sold: bigint; collateralOut: bigint; txHash: string | null; reason: string; note?: string },
): Promise<{ closed: boolean; applied: boolean }> {
  const sharesBefore = decimalToBigint(position.sharesRaw);
  const costBefore = position.costBasisRaw == null
    ? usdcFromNumber(position.trade?.amount ?? position.size)
    : decimalToBigint(position.costBasisRaw);
  const sold = p.sold > sharesBefore ? sharesBefore : p.sold;
  const remaining = sharesBefore - sold;
  const closed = remaining <= DUST_SHARES;
  const costSold = closed || sharesBefore === 0n ? costBefore : (costBefore * sold) / sharesBefore;
  const realisedPnlRaw = decimalToBigint(position.realisedPnlRaw) + (p.collateralOut - costSold);
  const effectivePrice = sold > 0n ? Math.min(1, Number(p.collateralOut) / Number(sold)) : null;

  const applied = await prisma.$transaction(async (tx) => {
    const won = await tx.positionExit.updateMany({
      where: { id: exitId, status: 'SUBMITTED' },
      data: {
        status: 'CONFIRMED',
        sharesSoldRaw: bigintToDecimalString(sold),
        collateralOutRaw: bigintToDecimalString(p.collateralOut),
        effectivePrice,
        txHash: p.txHash,
        error: p.note ?? null,
      },
    });
    if (won.count === 0) return false;
    await tx.position.update({
      where: { id: position.id },
      data: {
        sharesRaw: bigintToDecimalString(remaining),
        costBasisRaw: bigintToDecimalString(costBefore - costSold),
        realisedCollateralRaw: bigintToDecimalString(decimalToBigint(position.realisedCollateralRaw) + p.collateralOut),
        realisedPnlRaw: bigintToDecimalString(realisedPnlRaw),
        pnl: toDisplayUsdc(realisedPnlRaw),
        ...(closed
          ? {
              status: p.reason === 'STOP_LOSS' ? 'STOP_LOSS' : 'CLOSED',
              closedAt: new Date(),
              closeReason: p.reason,
              markValueRaw: '0',
              liquidationValueRaw: '0',
              unrealisedPnlRaw: '0',
              ...(effectivePrice !== null ? { currentPrice: effectivePrice } : {}),
            }
          : {}),
      } as any,
    });
    return true;
  });
  if (!applied) {
    const current = await prisma.position.findUnique({ where: { id: position.id }, select: { status: true } });
    return { closed: current != null && current.status !== 'OPEN', applied: false };
  }
  return { closed, applied: true };
}

/** Fills sharesRaw / costBasisRaw for a pre-#78 row from the on-chain balance. */
async function backfillShares(position: LoadedPosition, held: bigint): Promise<LoadedPosition> {
  const others = (await prisma.position.findMany({
    where: { marketId: position.marketId, direction: position.direction, status: 'OPEN', id: { not: position.id } },
    select: { id: true, size: true },
  })) as Array<{ id: string; size: number }>;
  const totalSize = position.size + others.reduce((acc, o) => acc + o.size, 0);
  // Several open positions share one on-chain balance: split it pro rata by size.
  const sizeRaw = usdcFromNumber(position.size);
  const totalRaw = usdcFromNumber(totalSize);
  const shares = others.length === 0 || totalRaw === 0n ? held : (held * sizeRaw) / totalRaw;
  const costBasisRaw = position.costBasisRaw == null ? usdcFromNumber(position.trade?.amount ?? position.size) : decimalToBigint(position.costBasisRaw);
  if (others.length > 0) {
    logger.warn(
      { positionId: position.id, held: held.toString(), assigned: shares.toString(), openPositions: others.length + 1 },
      'Several open positions share one on-chain balance; split pro rata by size',
    );
  }
  await prisma.position.update({
    where: { id: position.id },
    data: { sharesRaw: bigintToDecimalString(shares), costBasisRaw: bigintToDecimalString(costBasisRaw), valuationSource: 'estimated' } as any,
  });
  return { ...position, sharesRaw: shares.toString(), costBasisRaw: costBasisRaw.toString() };
}

/**
 * Resolves an exit stuck in SUBMITTED by comparing the on-chain balance with
 * the position's recorded shares. Returns false if it can't be decided yet.
 */
async function reconcileStuckExit(position: LoadedPosition, stuck: any): Promise<boolean> {
  try {
    const held = await chainHeld(position.market.onChainMarketId!, position.direction);
    const others = (await prisma.position.findMany({
      where: { marketId: position.marketId, direction: position.direction, status: 'OPEN', id: { not: position.id } },
      select: { sharesRaw: true },
    })) as Array<{ sharesRaw: any }>;
    const othersShares = others.reduce((acc, o) => acc + (o.sharesRaw == null ? 0n : decimalToBigint(o.sharesRaw)), 0n);
    const own = held > othersShares ? held - othersShares : 0n;
    const recorded = decimalToBigint(position.sharesRaw);
    if (own >= recorded) {
      await prisma.positionExit.update({
        where: { id: stuck.id },
        data: { status: 'FAILED', error: 'EXIT_RECONCILED_NOT_LANDED: on-chain balance unchanged' },
      });
      return true;
    }
    await applyConfirmedExit(position, stuck.id, {
      sold: recorded - own,
      collateralOut: decimalToBigint(stuck.collateralOutRaw),
      txHash: stuck.txHash ?? null,
      reason: stuck.reason,
      note: 'Reconciled from the on-chain balance; collateral is the planned collateral_out',
    });
    return true;
  } catch (err) {
    logger.warn({ err: errorText(err), exitId: stuck.id }, 'Could not reconcile stuck exit; blocking new exits');
    return false;
  }
}

/**
 * Sells `fraction` of a position's shares through treasury.agent_sell.
 * Never throws for chain-side failures: the outcome is in the returned status
 * and the PositionExit rows.
 */
export async function exitPosition(
  positionId: string,
  opts: { fraction?: number; reason: string },
): Promise<ExitResult> {
  const fraction = opts.fraction ?? 1;
  if (!(fraction > 0 && fraction <= 1)) {
    throw new AppError(400, 'INVALID_FRACTION', 'fraction must be in (0, 1]');
  }
  const fractionBps = BigInt(Math.round(fraction * 10_000));
  const mode = config.CHAIN_EXECUTION_MODE === 'live' ? 'live' : 'dry-run';

  let position = await loadPosition(positionId);
  if (!position) throw new AppError(404, 'POSITION_NOT_FOUND', 'Position not found');
  if (position.status !== 'OPEN') throw new AppError(409, 'POSITION_CLOSED', 'Position is already closed');
  const onChainMarketId = position.market.onChainMarketId;
  if (onChainMarketId === null) {
    throw new AppError(409, 'MARKET_NOT_ON_CHAIN', 'Market has no on-chain id yet');
  }
  const outcome = position.direction;
  const failed = async (code: string, extra: { error?: string; collateralOut?: bigint; maxSharesIn?: bigint } = {}): Promise<ExitResult> => {
    const row = await recordFailure(positionId, { mode, reason: opts.reason, code, ...extra });
    return { exitId: row.id, status: 'FAILED', code, sharesSoldRaw: 0n, collateralOutRaw: 0n, closed: false };
  };

  // A SUBMITTED exit blocks new ones until it is reconciled with the chain.
  const stuck = await prisma.positionExit.findFirst({ where: { positionId, status: 'SUBMITTED' } });
  if (stuck) {
    if (!(await reconcileStuckExit(position, stuck))) {
      return { exitId: stuck.id, status: 'SUBMITTED', code: 'EXIT_PENDING_RECONCILE', sharesSoldRaw: 0n, collateralOutRaw: 0n, closed: false };
    }
    position = await loadPosition(positionId);
    if (!position || position.status !== 'OPEN') {
      return { exitId: stuck.id, status: 'CONFIRMED', sharesSoldRaw: 0n, collateralOutRaw: 0n, closed: true };
    }
  }

  if (position.market.expiryTimestamp.getTime() - nowMs() < EXIT_CLOSE_GUARD_MS) {
    return failed('EXIT_MARKET_CLOSED', { error: 'within 60s of close_time; left to settlement' });
  }

  let held: bigint;
  try {
    held = await chainHeld(onChainMarketId, outcome);
  } catch (err) {
    return failed('EXIT_BALANCE_UNAVAILABLE', { error: errorText(err) });
  }
  if (position.sharesRaw == null) position = await backfillShares(position, held);

  let slippageRetries = 0;
  let insufficientRetries = 0;
  for (;;) {
    const recorded = decimalToBigint(position.sharesRaw);
    const available = recorded < held ? recorded : held;
    const target = (available * fractionBps) / 10_000n;
    if (target <= 0n) return failed('EXIT_NO_SHARES', { error: `recorded ${recorded}, on-chain ${held}` });

    let plan: ExitPlan;
    try {
      let market = await getOnChainMarket(onChainMarketId);
      plan = planExit(market, outcome, target, EXIT_SLIPPAGE_BPS, held);
      const quoted = await quoteSell(onChainMarketId, outcomeValue(outcome), plan.collateralOut);
      const drift = quoted > plan.quotedSharesIn ? quoted - plan.quotedSharesIn : plan.quotedSharesIn - quoted;
      if (drift > 1n) {
        market = await getOnChainMarket(onChainMarketId);
        plan = planExit(market, outcome, target, EXIT_SLIPPAGE_BPS, held);
      }
    } catch (err) {
      if (err instanceof ExitError) return failed(err.code, { error: err.message });
      const kind = classify(err);
      return failed(kind === 'ambiguous' ? 'EXIT_FAILED' : FAILURE_CODES[kind], { error: errorText(err) });
    }

    const row = await prisma.positionExit.create({
      data: {
        positionId,
        mode,
        reason: opts.reason,
        status: 'SUBMITTED',
        collateralOutRaw: bigintToDecimalString(plan.collateralOut),
        maxSharesInRaw: bigintToDecimalString(plan.maxSharesIn),
      },
    });

    try {
      const result = await agentSell(
        {
          market_id: onChainMarketId,
          outcome: outcomeValue(outcome),
          collateral_out: plan.collateralOut,
          max_shares_in: plan.maxSharesIn,
        },
        undefined,
        { kind: 'trade.sell', refId: row.id },
      );
      const sold = BigInt(result.value);

      if (result.mode === 'dry-run') {
        await prisma.positionExit.update({
          where: { id: row.id },
          data: {
            status: 'SIMULATED',
            sharesSoldRaw: bigintToDecimalString(sold),
            effectivePrice: sold > 0n ? Math.min(1, Number(plan.collateralOut) / Number(sold)) : null,
          },
        });
        return { exitId: row.id, status: 'SIMULATED', sharesSoldRaw: sold, collateralOutRaw: plan.collateralOut, closed: false };
      }

      // #35: the trade.sell completion handler may already have applied this
      // before agentSell resolved; applyConfirmedExit's CAS makes the second
      // call a read-back, so exactly one of the two applies the deltas.
      const { closed } = await applyConfirmedExit(position, row.id, {
        sold,
        collateralOut: plan.collateralOut,
        txHash: result.txHash,
        reason: opts.reason,
      });
      await writeAgentLog({
        agentType: 'TRADER',
        level: 'INFO',
        action: closed ? 'POSITION_CLOSED' : 'POSITION_REDUCED',
        marketId: position.marketId,
        data: {
          positionId,
          exitId: row.id,
          reason: opts.reason,
          sharesSoldRaw: sold.toString(),
          collateralOutRaw: plan.collateralOut.toString(),
          txHash: result.txHash,
        },
      }).catch(() => undefined);
      logger.info({ positionId, exitId: row.id, closed }, 'Position exit confirmed');
      return { exitId: row.id, status: 'CONFIRMED', sharesSoldRaw: sold, collateralOutRaw: plan.collateralOut, closed };
    } catch (err) {
      const kind = classify(err);

      if (kind === 'ambiguous') {
        // The transaction may have landed: leave SUBMITTED; the next call reconciles.
        await prisma.positionExit.update({ where: { id: row.id }, data: { error: errorText(err) } });
        return { exitId: row.id, status: 'SUBMITTED', code: 'EXIT_PENDING_RECONCILE', sharesSoldRaw: 0n, collateralOutRaw: plan.collateralOut, closed: false };
      }

      const code = FAILURE_CODES[kind];
      await prisma.positionExit.update({ where: { id: row.id }, data: { status: 'FAILED', error: `${code}: ${errorText(err)}` } });

      if (kind === 'slippage' && slippageRetries < MAX_SLIPPAGE_RETRIES) {
        slippageRetries++;
        continue; // re-plan from a fresh get_market
      }
      if (kind === 'insufficient' && insufficientRetries < MAX_INSUFFICIENT_RETRIES) {
        insufficientRetries++;
        try {
          held = await chainHeld(onChainMarketId, outcome);
          if (held < recorded) {
            await prisma.position.update({ where: { id: positionId }, data: { sharesRaw: bigintToDecimalString(held) } as any });
            position = { ...position, sharesRaw: held.toString() };
          }
          continue;
        } catch (readErr) {
          logger.warn({ err: errorText(readErr), positionId }, 'Could not re-read the on-chain balance');
        }
      }
      logger.warn({ positionId, exitId: row.id, code }, 'Position exit failed');
      return { exitId: row.id, status: 'FAILED', code, sharesSoldRaw: 0n, collateralOutRaw: plan.collateralOut, closed: false };
    }
  }
}

/**
 * Completion handler for `trade.sell` outbox rows (#35). It only applies an
 * exit that is still SUBMITTED: the inline path reads the handler's result
 * back, and a failure thrown to a live caller is marked handled upstream, so
 * this effectively runs once per exit — inline on confirmation, or from the
 * recovery worker after a crash or an ambiguous submission.
 */
export async function handleTradeSellOutcome(row: ChainTransactionRow, outcome: CompletionOutcome): Promise<void> {
  const exitId = row.refId;
  if (!exitId) return;
  const exit = await prisma.positionExit.findUnique({ where: { id: exitId } });
  if (!exit || exit.status !== 'SUBMITTED') return;

  if (outcome.status !== 'SUCCESS') {
    await prisma.positionExit.updateMany({
      where: { id: exitId, status: 'SUBMITTED' },
      data: {
        status: 'FAILED',
        error: outcome.status === 'EXPIRED' ? 'expired unsubmitted' : (outcome.error ?? 'failed on-chain'),
      },
    });
    return;
  }

  const position = await loadPosition(exit.positionId);
  if (!position) return;
  await applyConfirmedExit(position, exitId, {
    sold: BigInt(String(outcome.value ?? '0')),
    collateralOut: decimalToBigint(exit.collateralOutRaw ?? '0'),
    txHash: outcome.txHash ?? null,
    reason: exit.reason,
  });
}

registerHandler('trade.sell', handleTradeSellOutcome);
