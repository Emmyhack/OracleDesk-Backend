import {
  PaymentEventStatus,
  PaymentEventType,
  SettlementCurrency,
  SubscriptionStatus,
  SubscriptionType,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { CONTRACTS, PAYMENTS_RECIPIENT } from '../config/contracts';
import { formatUsdc, toDisplayUsdc } from '../lib/amounts';
import { verifyUsdcTransfer } from './payment-verification.service';
import { AppError } from '../middlewares/error.middleware';
import type { SubscriptionAccess } from '../types';
import { summarizeProvenance } from '../lib/llm/provenance';
import { withAdvisoryLockWait } from '../lib/advisory-lock';
import dayjs from 'dayjs';
import { notifyUser } from '../lib/socket-auth';

/** Daily pass price in 7-decimal USDC base units (DAILY_PASS_PRICE_RAW). */
export const DAILY_PASS_PRICE_RAW = BigInt(config.DAILY_PASS_PRICE_RAW);
/** Per-trace unlocks are sold by the x402 service, not this backend (docs/api.md). */
const PER_TRACE_PRICE_RAW = 50_000n; // 0.005 USDC, shown in previews only

/**
 * Checks whether a user has access to a specific reasoning trace.
 *
 * Access tiers:
 * 1. FREE_PREVIEW: Always granted — returns previewSources (first 2 sources)
 * 2. DAILY_PASS: User has an active daily pass → full access
 * 3. PER_TRACE: User paid for this specific trace → full access
 * 4. NO_ACCESS: Must pay
 */
export async function checkAccess(
  userId: string,
  traceId: string,
): Promise<SubscriptionAccess> {
  // Check for active daily pass (covers all traces)
  const dailyPass = await prisma.subscription.findFirst({
    where: {
      userId,
      type:   SubscriptionType.DAILY_PASS,
      status: SubscriptionStatus.ACTIVE,
      expiresAt: { gt: new Date() },
    },
  });

  if (dailyPass) {
    return { hasAccess: true, accessType: 'DAILY_PASS', expiresAt: dailyPass.expiresAt ?? undefined };
  }

  // Check for a per-trace subscription for this trace
  const perTrace = await prisma.subscription.findFirst({
    where: {
      userId,
      traceId,
      type:   SubscriptionType.PER_TRACE,
      status: SubscriptionStatus.ACTIVE,
    },
  });

  if (perTrace) {
    return { hasAccess: true, accessType: 'PER_TRACE' };
  }

  return { hasAccess: false, accessType: 'NO_ACCESS' };
}

/**
 * Records a daily-pass payment and grants access.
 *
 * The transaction must be a successful USDC `transfer` from the user's own
 * wallet to PAYMENTS_RECIPIENT for at least the price, verified on-chain
 * (payment-verification.service.ts). Each transaction hash is used once.
 * Per-trace unlocks go through the x402 service instead.
 */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

/** How long a request waits for the current claimant of a txHash. */
const CLAIM_WAIT_MS = 30_000;
/** Interactive-transaction budget: it covers one RPC verification plus writes. */
const CLAIM_TX_TIMEOUT_MS = 60_000;

/** The advisory-lock key that serializes claims for one transaction hash. */
export function paymentClaimLockKey(txHash: string): string {
  return `payment:claim:${txHash.toLowerCase()}`;
}

/**
 * Resolves a hash that is already recorded: its owner gets the subscription it
 * bought (idempotent success), anyone else gets 409. Never reveals whose hash
 * it is beyond the comparison with the caller's user id.
 */
async function existingClaimResult(
  db: Prisma.TransactionClient | typeof prisma,
  txHash: string,
  userId: string,
): Promise<any> {
  const existing = await db.paymentEvent.findUnique({ where: { txHash } });
  if (!existing) return null;
  if (existing.userId === userId) {
    const sub = await db.subscription.findFirst({ where: { txHash } });
    if (sub) return sub;
  }
  throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This payment has already been used');
}

export interface ClaimResult {
  subscription: any;
  transfer: { amount: bigint; ledger: number; from: string } | null;
  replay: boolean;
}

export async function recordPayment(params: {
  userId:        string;
  walletAddress: string;
  traceId?:      string;
  type:          'PER_TRACE' | 'DAILY_PASS';
  txHash:        string;
  /** Sub-identity of a pooled account (#46); proven against the payment. */
  subId?:        string | null;
  subIdKind?:    'MUXED' | 'MEMO' | null;
}): Promise<any> {
  const { userId, walletAddress, traceId, type, subId, subIdKind } = params;
  const txHash = params.txHash.toLowerCase();

  if (type !== 'DAILY_PASS') {
    throw new AppError(400, 'USE_X402', 'Per-trace unlocks are paid through the x402 trace service, not this endpoint');
  }

  // Idempotency: a hash is consumed once. Re-submitting your own hash returns
  // the subscription it already bought; anyone else's hash is rejected. This
  // read is only an optimization: the authoritative check happens under the
  // per-hash lock below, after any in-flight claimant has finished.
  const early = await existingClaimResult(prisma, txHash, userId);
  if (early) return early;

  // #59: serialize every claim for this hash. Verification runs at most once
  // at a time, racers wait and then reuse the winner's result instead of each
  // paying for an RPC read, and the unique index remains as defence in depth.
  // The lock is a transaction-scoped Postgres advisory lock, so it is safe
  // across instances and is released by the server if this process dies.
  let claim: { acquired: true; value: ClaimResult } | { acquired: false };
  try {
    claim = await withAdvisoryLockWait<ClaimResult>(
      paymentClaimLockKey(txHash),
      async (tx) => {
        // A racer that waited may now see the committed winner.
        const existing = await existingClaimResult(tx, txHash, userId);
        if (existing) return { subscription: existing, transfer: null, replay: true };

        // Cheap checks before the RPC call: the approval read and, as a lower
        // bound, the price floor. The verified amount is re-checked below.
        const allowance = await enforceSpendingAllowance(userId, type, tx);
        allowance.evaluate(toDisplayUsdc(DAILY_PASS_PRICE_RAW));

        const transfer = await verifyUsdcTransfer({
          txHash,
          token:     CONTRACTS.usdc,
          from:      walletAddress,
          to:        PAYMENTS_RECIPIENT,
          minAmount: DAILY_PASS_PRICE_RAW,
          subId,
          subIdKind,
        });
        const amount = toDisplayUsdc(transfer.amount);

        // The verified amount is what counts against the allowance.
        allowance.evaluate(amount);

        const expiresAt = dayjs().add(24, 'hour').toDate();

        const created = await tx.subscription.create({
          data: {
            userId,
            traceId:   traceId ?? null,
            type:      type as SubscriptionType,
            status:    SubscriptionStatus.ACTIVE,
            amountPaid: amount,
            currency:  SettlementCurrency.USDC,
            txHash,
            expiresAt,
          },
        });

        // Unique on txHash: a concurrent request with the same hash would fail
        // here, but the advisory lock above already serialized them.
        await tx.paymentEvent.create({
          data: {
            userId,
            traceId:     traceId ?? null,
            txHash,
            type:        type as PaymentEventType,
            amount,
            amountRaw:   transfer.amount.toString(),
            fromAddress: transfer.from,
            currency:    SettlementCurrency.USDC,
            status:      PaymentEventStatus.CONFIRMED,
            confirmedAt: new Date(),
            metadata:    { subscriptionId: created.id, ledger: transfer.ledger } as any,
          },
        });

        await tx.spendingAllowance.updateMany({
          where: { userId, isActive: true },
          data: { spentToday: { increment: amount } },
        });

        return { subscription: created, transfer, replay: false };
      },
      { waitMs: CLAIM_WAIT_MS, timeoutMs: CLAIM_TX_TIMEOUT_MS },
    );
  } catch (err) {
    // The claim transaction rolled back. Only now may the LIMIT_REACHED row be
    // written, so a losing racer never leaves one behind.
    if (err instanceof AllowanceLimitError) {
      await recordLimitReached(err);
    }
    if (isUniqueViolation(err)) {
      const winner = await existingClaimResult(prisma, txHash, userId);
      if (winner) return winner;
      throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This payment has already been used');
    }
    throw err;
  }

  if (!claim.acquired) {
    // The holder did not finish in time. Re-read once: it may have committed
    // just after the deadline. Never fall through to a second verification.
    const late = await existingClaimResult(prisma, txHash, userId);
    if (late) return late;
    throw new AppError(409, 'PAYMENT_CLAIM_IN_PROGRESS', 'This payment is being processed; retry shortly');
  }

  const { subscription, transfer, replay } = claim.value;
  if (replay || !transfer) return subscription;

  logger.info({ subscriptionId: subscription.id, type, userId, amountRaw: transfer.amount.toString() }, 'Subscription created');
  // Only after the transaction committed: a rolled-back payment must not be announced.
  // The idempotent re-submit paths above return earlier and never reach this.
  notifyUser(userId, 'PAYMENT_CONFIRMED', {
    subscriptionId: subscription.id,
    type,
    txHash,
    amountRaw: transfer.amount.toString(),
    expiresAt: subscription.expiresAt,
  });
  return subscription;
}

/**
 * Retrieves a trace, applying the correct access tier.
 *
 * - Free preview: returns previewSources only (first 2 sources)
 * - Full access: returns complete trace including all sourcesUsed
 */
export async function getTracWithAccessControl(
  traceId: string,
  userId?: string,
): Promise<any> {
  const trace = await prisma.reasoningTrace.findUnique({
    where: { id: traceId },
    include: { market: { select: { question: true, category: true, settlementCurrency: true, onChainMarketId: true } } },
  });

  if (!trace) throw new AppError(404, 'TRACE_NOT_FOUND', 'Reasoning trace not found');

  // Determine access level
  let access: SubscriptionAccess = { hasAccess: false, accessType: 'FREE_PREVIEW' };
  if (userId) {
    const fullAccess = await checkAccess(userId, traceId);
    access = fullAccess;
  }

  const audit = trace.lastAuditStatus
    ? { status: trace.lastAuditStatus, checkedAt: trace.lastAuditedAt }
    : null;

  if (access.hasAccess) {
    return { ...trace, audit, accessLevel: access.accessType };
  }

  // Return free preview — strip full sources
  return {
    id:                  trace.id,
    marketId:            trace.marketId,
    market:              trace.market,
    agentType:           trace.agentType,
    decisionType:        trace.decisionType,
    probabilityEstimate: trace.probabilityEstimate,
    marketProbability:   trace.marketProbability,
    edge:                trace.edge,
    confidenceInterval:  trace.confidenceInterval,
    sourcesUsed:         trace.previewSources,  // Preview: only first 2 sources
    // Reduced provenance (#66): enough to see how it was produced, not the hashes.
    provenance:          { summary: summarizeProvenance(trace.provenance) },
    verified:            trace.verified,
    audit,
    ipfsCid:             trace.ipfsCid,
    traceHash:           trace.traceHash,
    onChainTraceId:      trace.onChainTraceId,
    createdAt:           trace.createdAt,
    accessLevel:         'FREE_PREVIEW',
    lockedFields:        ['fullSources', 'hedgeConditions', 'betFraction', 'betSizeUsdc', 'provenance.llm', 'provenance.generator'],
    unlockPriceRaw:      PER_TRACE_PRICE_RAW.toString(),
    dailyPassPriceRaw:   DAILY_PASS_PRICE_RAW.toString(),
    dailyPassPrice:      formatUsdc(DAILY_PASS_PRICE_RAW),
  };
}

/**
 * Expires overdue subscriptions.
 * Called by a scheduled cron job.
 */
export async function expireStaleSubscriptions(): Promise<number> {
  const { count } = await prisma.subscription.updateMany({
    where: {
      status:    'ACTIVE',
      expiresAt: { lt: new Date() },
    },
    data: { status: 'EXPIRED' },
  });

  if (count > 0) logger.info({ count }, 'Expired stale subscriptions');
  return count;
}

/**
 * Emits PASS_EXPIRING once per daily pass that expires within `windowMins`.
 * The pass is claimed with a conditional update before emitting, so concurrent
 * instances and repeated runs notify at most once (#94).
 */
export async function notifyExpiringPasses(windowMins = 60, now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + windowMins * 60_000);
  const passes = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      type: SubscriptionType.DAILY_PASS,
      expiresAt: { gt: now, lte: horizon },
      expiryNotifiedAt: null,
    },
    select: { id: true, userId: true, expiresAt: true },
    take: 500,
  });

  let notified = 0;
  for (const pass of passes) {
    const claim = await prisma.subscription.updateMany({
      where: { id: pass.id, expiryNotifiedAt: null },
      data: { expiryNotifiedAt: now },
    });
    if (claim.count !== 1) continue;
    notifyUser(pass.userId, 'PASS_EXPIRING', { subscriptionId: pass.id, expiresAt: pass.expiresAt });
    notified++;
  }
  if (notified > 0) logger.info({ notified }, 'Notified users of expiring passes');
  return notified;
}

export async function upsertSpendingAllowance(params: {
  userId: string;
  dailyLimit: number;
  perTraceLimit: number;
  currency?: string;
}): Promise<any> {
  const { userId, dailyLimit, perTraceLimit, currency = 'USDC' } = params;

  if (dailyLimit <= 0 || perTraceLimit <= 0 || perTraceLimit > dailyLimit) {
    throw new AppError(400, 'INVALID_ALLOWANCE', 'perTraceLimit and dailyLimit must be positive, and perTraceLimit cannot exceed dailyLimit');
  }

  return prisma.spendingAllowance.upsert({
    where: { userId },
    create: { userId, dailyLimit, perTraceLimit, currency: currency as 'USDC' },
    update: { dailyLimit, perTraceLimit, currency: currency as 'USDC', isActive: true },
  });
}

export async function getSpendingAllowance(userId: string): Promise<any> {
  return prisma.spendingAllowance.findUnique({ where: { userId } });
}

/**
 * A refused purchase. The LIMIT_REACHED row is written by the caller after the
 * claim transaction has rolled back, so only the user who actually won the
 * claim can leave one behind (never a losing racer) and the row survives the
 * rollback that the refusal causes.
 */
class AllowanceLimitError extends AppError {
  constructor(
    code: 'ALLOWANCE_PER_TRACE_LIMIT' | 'ALLOWANCE_DAILY_LIMIT',
    message: string,
    public readonly limitRow: {
      userId: string;
      type: SubscriptionType;
      amountPaid: number;
      currency: SettlementCurrency;
    } | null,
  ) {
    super(402, code, message);
    this.name = 'AllowanceLimitError';
  }
}

export interface AllowanceDecision {
  /** Throws an AllowanceLimitError when `amount` exceeds the approval. */
  evaluate(amount: number): void;
}

/**
 * Reads the spending approval inside the claim transaction. The approval is
 * evaluated only after the on-chain amount is known, but the read itself is
 * cheap and runs before any RPC call. A daily reset is applied inside the same
 * transaction, so it commits only together with the purchase it belongs to.
 *
 * #59: this function no longer writes LIMIT_REACHED itself. The caller writes
 * that row only after winning the per-hash claim and after the transaction
 * rolls back, so concurrent losers cannot create duplicate rows.
 */
async function enforceSpendingAllowance(
  userId: string,
  type: 'PER_TRACE' | 'DAILY_PASS',
  tx: Prisma.TransactionClient,
): Promise<AllowanceDecision> {
  const allowance = await tx.spendingAllowance.findUnique({ where: { userId } });
  if (!allowance?.isActive) return { evaluate: () => undefined };

  const resetNeeded = dayjs(allowance.lastResetAt).isBefore(dayjs().startOf('day'));
  const effectiveSpentToday = resetNeeded ? 0 : allowance.spentToday;

  if (resetNeeded) {
    await tx.spendingAllowance.update({
      where: { userId },
      data: { spentToday: 0, lastResetAt: new Date() },
    });
  }

  const currency = (allowance.currency as SettlementCurrency) || SettlementCurrency.USDC;
  return {
    evaluate(amount: number): void {
      if (type === 'PER_TRACE' && amount > allowance.perTraceLimit) {
        throw new AllowanceLimitError(
          'ALLOWANCE_PER_TRACE_LIMIT',
          'Payment exceeds per-trace spending approval',
          null,
        );
      }
      if (effectiveSpentToday + amount > allowance.dailyLimit) {
        throw new AllowanceLimitError(
          'ALLOWANCE_DAILY_LIMIT',
          'Payment exceeds daily spending approval',
          { userId, type: type as SubscriptionType, amountPaid: amount, currency },
        );
      }
    },
  };
}

/**
 * Persists the LIMIT_REACHED marker for a refused purchase. The row is written
 * outside the claim transaction (so it survives the rollback that the refusal
 * causes) and deduplicated per user, amount and UTC day, so a burst of
 * concurrent refusals leaves one marker rather than one per request.
 */
async function recordLimitReached(err: AllowanceLimitError): Promise<void> {
  if (!err.limitRow) return;
  try {
    const existing = await prisma.subscription.findFirst({
      where: {
        userId: err.limitRow.userId,
        status: SubscriptionStatus.LIMIT_REACHED,
        amountPaid: err.limitRow.amountPaid,
        createdAt: { gte: dayjs().startOf('day').toDate() },
      },
      select: { id: true },
    });
    if (existing) return;
    await prisma.subscription.create({
      data: { ...err.limitRow, status: SubscriptionStatus.LIMIT_REACHED, txHash: null },
    });
  } catch (writeErr) {
    // Never mask the 402 the caller is about to return.
    logger.warn({ err: writeErr, userId: err.limitRow.userId }, 'Could not record LIMIT_REACHED subscription');
  }
}

export async function listPaymentEvents(userId: string): Promise<any[]> {
  return prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}
