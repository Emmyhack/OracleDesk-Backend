import {
  PaymentEventStatus,
  PaymentEventType,
  SettlementCurrency,
  SubscriptionStatus,
  SubscriptionType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { CONTRACTS, PAYMENTS_RECIPIENT } from '../config/contracts';
import { formatUsdc, toDisplayUsdc } from '../lib/amounts';
import { verifyUsdcTransfer } from './payment-verification.service';
import { AppError } from '../middlewares/error.middleware';
import type { SubscriptionAccess } from '../types';
import { summarizeProvenance } from '../lib/llm/provenance';
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
  // the subscription it already bought; anyone else's hash is rejected.
  const existing = await prisma.paymentEvent.findUnique({ where: { txHash } });
  if (existing) {
    if (existing.userId === userId) {
      const sub = await prisma.subscription.findFirst({ where: { txHash } });
      if (sub) return sub;
    }
    throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This payment has already been used');
  }

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

  await enforceSpendingAllowance(userId, amount, type);

  const expiresAt = dayjs().add(24, 'hour').toDate();

  let subscription;
  try {
    subscription = await prisma.$transaction(async (tx) => {
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

      // Unique on txHash: a concurrent request with the same hash fails here.
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

      return created;
    });
  } catch (err) {
    // #123: a concurrent duplicate with the same txHash loses the unique race
    // on PaymentEvent.txHash (P2002). Resolve it like the pre-check above
    // instead of surfacing a 500, with or without an Idempotency-Key.
    if (isUniqueViolation(err)) {
      const winner = await prisma.paymentEvent.findUnique({ where: { txHash } });
      if (winner?.userId === userId) {
        const sub = await prisma.subscription.findFirst({ where: { txHash } });
        if (sub) return sub;
      }
      throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This payment has already been used');
    }
    throw err;
  }

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

async function enforceSpendingAllowance(
  userId: string,
  amount: number,
  type: 'PER_TRACE' | 'DAILY_PASS',
): Promise<void> {
  const allowance = await prisma.spendingAllowance.findUnique({ where: { userId } });
  if (!allowance?.isActive) return;

  const resetNeeded = dayjs(allowance.lastResetAt).isBefore(dayjs().startOf('day'));
  const effectiveSpentToday = resetNeeded ? 0 : allowance.spentToday;

  if (resetNeeded) {
    await prisma.spendingAllowance.update({
      where: { userId },
      data: { spentToday: 0, lastResetAt: new Date() },
    });
  }

  if (type === 'PER_TRACE' && amount > allowance.perTraceLimit) {
    throw new AppError(402, 'ALLOWANCE_PER_TRACE_LIMIT', 'Payment exceeds per-trace spending approval');
  }

  if (effectiveSpentToday + amount > allowance.dailyLimit) {
    await prisma.subscription.create({
      data: {
        userId,
        type: type as SubscriptionType,
        status: SubscriptionStatus.LIMIT_REACHED,
        amountPaid: amount,
        currency: (allowance.currency as SettlementCurrency) || SettlementCurrency.USDC,
        txHash: null,
      },
    });
    throw new AppError(402, 'ALLOWANCE_DAILY_LIMIT', 'Payment exceeds daily spending approval');
  }
}

export async function listPaymentEvents(userId: string): Promise<any[]> {
  return prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}
