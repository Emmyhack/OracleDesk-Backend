import {
  PaymentEventStatus,
  PaymentEventType,
  Prisma,
  SettlementCurrency,
  SubscriptionStatus,
  SubscriptionType,
} from '@prisma/client';
import type { VerifiedTransfer } from './payment-verification.service';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { CONTRACTS, PAYMENTS_RECIPIENT } from '../config/contracts';
import { decimalToBigint, formatUsdc, toDisplayUsdc, usdcFromNumber } from '../lib/amounts';
import { verifyUsdcTransfer } from './payment-verification.service';
import { AppError } from '../middlewares/error.middleware';
import type { SubscriptionAccess } from '../types';
import { summarizeProvenance } from '../lib/llm/provenance';
import { withAdvisoryLocksWait } from '../lib/advisory-lock';
import { DAY_MS, ledgerCloseDate, utcDayStart } from '../lib/time';
import { notifyUser } from '../lib/socket-auth';
import { discoverTracePrice } from './x402-discovery.service';

/** Daily pass price in 7-decimal USDC base units (DAILY_PASS_PRICE_RAW). */
export const DAILY_PASS_PRICE_RAW = BigInt(config.DAILY_PASS_PRICE_RAW);

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
  // Check for active daily pass (covers all traces). New rows use the
  // ledger-anchored [startsAt, endsAt) window (#54); legacy rows fall back to
  // expiresAt after the backfill.
  const now = new Date();
  const dailyPass = await prisma.subscription.findFirst({
    where: {
      userId,
      type:   SubscriptionType.DAILY_PASS,
      status: SubscriptionStatus.ACTIVE,
      AND: [
        { OR: [{ startsAt: { lte: now } }, { startsAt: null }] },
        {
          OR: [
            { endsAt: { gt: now } },
            { endsAt: null, expiresAt: { gt: now } },
          ],
        },
      ],
    },
    orderBy: [{ endsAt: 'desc' }],
  });

  if (dailyPass) {
    return {
      hasAccess: true,
      accessType: 'DAILY_PASS',
      expiresAt: dailyPass.endsAt ?? dailyPass.expiresAt ?? undefined,
    };
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

/** One lock per user orders allowance and pass-stacking writes (#53/#54). */
export function userPaymentLockKey(userId: string): string {
  return `payment:user:${userId}`;
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

export interface Preauthorization {
  active: boolean;
  allowed: boolean;
  reason: 'ALLOWANCE_PER_TRACE_LIMIT' | 'ALLOWANCE_DAILY_LIMIT' | null;
  dailyLimitRaw: string | null;
  perTraceLimitRaw: string | null;
  spentTodayRaw: string;
  remainingRaw: string | null;
  overageRaw: string;
  wouldOverflowRaw: string;
}

/** Advisory-only allowance check. Never writes or reserves budget (#53). */
export async function preauthorizeSpending(
  userId: string,
  type: 'PER_TRACE' | 'DAILY_PASS',
  amountRaw: bigint,
  now = new Date(),
): Promise<Preauthorization> {
  const allowance = await prisma.spendingAllowance.findUnique({ where: { userId } });
  if (!allowance?.isActive) {
    return {
      active: false,
      allowed: true,
      reason: null,
      dailyLimitRaw: null,
      perTraceLimitRaw: null,
      spentTodayRaw: '0',
      remainingRaw: null,
      overageRaw: '0',
      wouldOverflowRaw: '0',
    };
  }
  const dayStart = utcDayStart(now);
  const reset = allowance.windowStartedAt < dayStart;
  const dailyLimit = decimalToBigint(allowance.dailyLimitRaw);
  const perTraceLimit = decimalToBigint(allowance.perTraceLimitRaw);
  const spent = reset ? 0n : decimalToBigint(allowance.spentTodayRaw);
  const remaining = dailyLimit > spent ? dailyLimit - spent : 0n;
  const perTraceExceeded = type === 'PER_TRACE' && perTraceLimit > 0n && amountRaw > perTraceLimit;
  const dailyExceeded = dailyLimit > 0n && amountRaw > remaining;
  const reason = perTraceExceeded
    ? 'ALLOWANCE_PER_TRACE_LIMIT'
    : dailyExceeded
      ? 'ALLOWANCE_DAILY_LIMIT'
      : null;
  return {
    active: true,
    allowed: reason === null,
    reason,
    dailyLimitRaw: dailyLimit.toString(),
    perTraceLimitRaw: perTraceLimit.toString(),
    spentTodayRaw: spent.toString(),
    remainingRaw: remaining.toString(),
    overageRaw: decimalToBigint(allowance.overageRaw).toString(),
    wouldOverflowRaw: (amountRaw > remaining ? amountRaw - remaining : 0n).toString(),
  };
}

/**
 * Applies the exact amount to the raw allowance counters inside the payment
 * transaction. Over-limit payments are accepted (the chain already moved the
 * money) and flagged, never rejected or silently dropped (#53).
 */
async function applyAllowance(
  tx: Prisma.TransactionClient,
  userId: string,
  type: 'PER_TRACE' | 'DAILY_PASS',
  amountRaw: bigint,
  now: Date,
): Promise<{ overageRaw: bigint; perTraceExceeded: boolean }> {
  const allowance = await tx.spendingAllowance.findUnique({ where: { userId } });
  if (!allowance?.isActive) return { overageRaw: 0n, perTraceExceeded: false };

  const dayStart = utcDayStart(now);
  const reset = allowance.windowStartedAt < dayStart;
  const dailyLimit = decimalToBigint(allowance.dailyLimitRaw);
  const perTraceLimit = decimalToBigint(allowance.perTraceLimitRaw);
  const spent = reset ? 0n : decimalToBigint(allowance.spentTodayRaw);
  const previousOverage = decimalToBigint(allowance.overageRaw);

  let newSpent = spent;
  let newOverage = previousOverage;
  if (dailyLimit > 0n) {
    const remaining = dailyLimit > spent ? dailyLimit - spent : 0n;
    if (amountRaw > remaining) {
      newSpent = dailyLimit;
      newOverage += amountRaw - remaining;
    } else {
      newSpent = spent + amountRaw;
    }
  } else {
    newSpent = spent + amountRaw;
  }

  const perTraceExceeded = type === 'PER_TRACE' && perTraceLimit > 0n && amountRaw > perTraceLimit;
  await tx.spendingAllowance.update({
    where: { userId },
    data: {
      spentTodayRaw: newSpent.toString(),
      spentToday: toDisplayUsdc(newSpent),
      overageRaw: newOverage.toString(),
      ...(reset ? { windowStartedAt: dayStart, lastResetAt: now } : {}),
    },
  });
  return { overageRaw: newOverage - previousOverage, perTraceExceeded };
}

export interface SettlementResult {
  subscription: any;
  paymentEventId: string;
  overageRaw: bigint;
  perTraceExceeded: boolean;
  ledgerCloseAt: Date;
  granted: boolean;
}

/**
 * Creates the subscription and payment event for an already verified transfer.
 * Callers must hold the payment and user advisory locks and have checked that
 * the txHash is unused.
 */
export async function settleVerifiedTransfer(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    traceId?: string | null;
    type: 'PER_TRACE' | 'DAILY_PASS';
    transfer: VerifiedTransfer;
    paymentIntentId?: string | null;
    now?: Date;
  },
): Promise<SettlementResult> {
  const { userId, traceId, type, transfer, paymentIntentId } = params;
  const txHash = transfer.txHash.toLowerCase();
  const now = params.now ?? new Date();
  const ledgerCloseAt = ledgerCloseDate(transfer.createdAt) ?? now;

  let startsAt = ledgerCloseAt;
  if (type === 'DAILY_PASS') {
    const latest = await tx.subscription.findFirst({
      where: {
        userId,
        type: SubscriptionType.DAILY_PASS,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING_PAYMENT] },
        OR: [
          { endsAt: { gt: ledgerCloseAt } },
          { endsAt: null, expiresAt: { gt: ledgerCloseAt } },
        ],
      },
      orderBy: [{ endsAt: 'desc' }],
    });
    const latestEnd = latest?.endsAt ?? latest?.expiresAt ?? null;
    if (latestEnd && latestEnd > ledgerCloseAt) startsAt = latestEnd;
  }
  const endsAt = new Date(startsAt.getTime() + DAY_MS);
  const granted = endsAt > now;
  const amountRaw = transfer.amount;
  const amount = toDisplayUsdc(amountRaw);
  const allowance = await applyAllowance(tx, userId, type, amountRaw, now);

  const created = await tx.subscription.create({
    data: {
      userId,
      traceId: traceId ?? null,
      type: type as SubscriptionType,
      status: granted ? SubscriptionStatus.ACTIVE : SubscriptionStatus.EXPIRED,
      amountPaid: amount,
      currency: SettlementCurrency.USDC,
      txHash,
      purchaseLedger: transfer.ledger,
      startsAt,
      endsAt,
      expiresAt: endsAt,
      paymentIntentId: paymentIntentId ?? null,
    },
  });

  const paymentEvent = await tx.paymentEvent.create({
    data: {
      userId,
      traceId: traceId ?? null,
      txHash,
      type: type as PaymentEventType,
      amount,
      amountRaw: amountRaw.toString(),
      fromAddress: transfer.from,
      currency: SettlementCurrency.USDC,
      status: PaymentEventStatus.CONFIRMED,
      ledger: transfer.ledger,
      ledgerCloseTime: ledgerCloseAt,
      allowanceOverage: allowance.overageRaw > 0n,
      allowanceOverageRaw: allowance.overageRaw.toString(),
      paymentIntentId: paymentIntentId ?? null,
      confirmedAt: now,
      metadata: {
        subscriptionId: created.id,
        ledger: transfer.ledger,
        ledgerCloseTime: ledgerCloseAt.toISOString(),
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        granted,
        allowanceOverageRaw: allowance.overageRaw.toString(),
        perTraceExceeded: allowance.perTraceExceeded,
      } as any,
    },
  });

  return {
    subscription: created,
    paymentEventId: paymentEvent.id,
    overageRaw: allowance.overageRaw,
    perTraceExceeded: allowance.perTraceExceeded,
    ledgerCloseAt,
    granted,
  };
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

  // #59 serialises every claim for this hash. #53/#54 additionally serialise
  // per user so allowance/stacking writes cannot interleave across hashes.
  let claim: { acquired: true; value: ClaimResult } | { acquired: false };
  try {
    claim = await withAdvisoryLocksWait<ClaimResult>(
      [paymentClaimLockKey(txHash), userPaymentLockKey(userId)],
      async (tx) => {
        // A racer that waited may now see the committed winner.
        const existing = await existingClaimResult(tx, txHash, userId);
        if (existing) return { subscription: existing, transfer: null, replay: true };

        const transfer = await verifyUsdcTransfer({
          txHash,
          token:     CONTRACTS.usdc,
          from:      walletAddress,
          to:        PAYMENTS_RECIPIENT,
          minAmount: DAILY_PASS_PRICE_RAW,
          subId,
          subIdKind,
        });

        const settlement = await settleVerifiedTransfer(tx, {
          userId,
          traceId: traceId ?? null,
          type,
          transfer,
        });

        return { subscription: settlement.subscription, transfer, replay: false };
      },
      { waitMs: CLAIM_WAIT_MS, timeoutMs: CLAIM_TX_TIMEOUT_MS },
    );
  } catch (err) {
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

  logger.info(
    {
      subscriptionId: subscription.id,
      type,
      userId,
      amountRaw: transfer.amount.toString(),
      startsAt: subscription.startsAt,
      endsAt: subscription.endsAt,
    },
    'Subscription created',
  );
  // Only after the transaction committed: a rolled-back payment must not be announced.
  // The idempotent re-submit paths above return earlier and never reach this.
  notifyUser(userId, 'PAYMENT_CONFIRMED', {
    subscriptionId: subscription.id,
    type,
    txHash,
    amountRaw: transfer.amount.toString(),
    expiresAt: subscription.endsAt ?? subscription.expiresAt,
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

  // Discover live x402 trace price (#63)
  const discovered = await discoverTracePrice(trace.onChainTraceId ?? trace.id);
  const isDiscovered = discovered.status === 'discovered';

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
    unlockPriceRaw:      isDiscovered ? discovered.amountRaw : null,
    unlockPrice:         isDiscovered ? discovered.amountUsdc : null,
    unlockPriceStatus:   discovered.status,
    paymentRequirements: isDiscovered ? discovered.requirements : null,
    dailyPassPriceRaw:   DAILY_PASS_PRICE_RAW.toString(),
    dailyPassPrice:      formatUsdc(DAILY_PASS_PRICE_RAW),
  };
}

/**
 * Expires overdue subscriptions.
 * Called by a scheduled cron job.
 */
export async function expireStaleSubscriptions(now = new Date()): Promise<number> {
  const { count } = await prisma.subscription.updateMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { endsAt: { lte: now } },
        { endsAt: null, expiresAt: { lte: now } },
      ],
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
      expiryNotifiedAt: null,
      OR: [
        { endsAt: { gt: now, lte: horizon } },
        { endsAt: null, expiresAt: { gt: now, lte: horizon } },
      ],
    },
    select: { id: true, userId: true, endsAt: true, expiresAt: true },
    take: 500,
  });

  let notified = 0;
  for (const pass of passes) {
    const claim = await prisma.subscription.updateMany({
      where: { id: pass.id, expiryNotifiedAt: null },
      data: { expiryNotifiedAt: now },
    });
    if (claim.count !== 1) continue;
    const expiresAt = pass.endsAt ?? pass.expiresAt;
    notifyUser(pass.userId, 'PASS_EXPIRING', { subscriptionId: pass.id, expiresAt });
    notified++;
  }
  if (notified > 0) logger.info({ notified }, 'Notified users of expiring passes');
  return notified;
}

export async function upsertSpendingAllowance(params: {
  userId: string;
  dailyLimit: number;
  perTraceLimit: number;
  dailyLimitRaw?: string;
  perTraceLimitRaw?: string;
  currency?: string;
}): Promise<any> {
  const { userId, dailyLimit, perTraceLimit, currency = 'USDC' } = params;

  if (dailyLimit <= 0 || perTraceLimit <= 0 || perTraceLimit > dailyLimit) {
    throw new AppError(400, 'INVALID_ALLOWANCE', 'perTraceLimit and dailyLimit must be positive, and perTraceLimit cannot exceed dailyLimit');
  }
  let dailyRaw = params.dailyLimitRaw ? BigInt(params.dailyLimitRaw) : usdcFromNumber(dailyLimit);
  let perTraceRaw = params.perTraceLimitRaw ? BigInt(params.perTraceLimitRaw) : usdcFromNumber(perTraceLimit);
  if (dailyRaw <= 0n || perTraceRaw <= 0n || perTraceRaw > dailyRaw) {
    throw new AppError(400, 'INVALID_ALLOWANCE', 'dailyLimitRaw must be positive and at least perTraceLimitRaw');
  }
  if (dailyRaw > (2n ** 127n - 1n)) {
    throw new AppError(400, 'INVALID_ALLOWANCE', 'dailyLimitRaw is too large');
  }

  const now = new Date();
  return prisma.spendingAllowance.upsert({
    where: { userId },
    create: {
      userId,
      dailyLimit,
      perTraceLimit,
      dailyLimitRaw: dailyRaw.toString(),
      perTraceLimitRaw: perTraceRaw.toString(),
      spentTodayRaw: '0',
      overageRaw: '0',
      windowStartedAt: utcDayStart(now),
      currency: currency as 'USDC',
    },
    update: {
      dailyLimit,
      perTraceLimit,
      dailyLimitRaw: dailyRaw.toString(),
      perTraceLimitRaw: perTraceRaw.toString(),
      currency: currency as 'USDC',
      isActive: true,
    },
  });
}

export async function getSpendingAllowance(userId: string): Promise<any> {
  return prisma.spendingAllowance.findUnique({ where: { userId } });
}

export async function listPaymentEvents(userId: string): Promise<any[]> {
  return prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}
