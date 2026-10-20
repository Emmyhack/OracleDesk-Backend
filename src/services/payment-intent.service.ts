import { randomBytes } from 'node:crypto';
import {
  PaymentEventStatus,
  PaymentEventType,
  PaymentIntentStatus,
  Prisma,
  SettlementCurrency,
  SubscriptionType,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { CONTRACTS, PAYMENTS_RECIPIENT } from '../config/contracts';
import { AppError } from '../middlewares/error.middleware';
import { logger } from '../lib/logger';
import { decimalToBigint, toDisplayUsdc } from '../lib/amounts';
import { ledgerCloseDate } from '../lib/time';
import {
  withAdvisoryLocksWait,
} from '../lib/advisory-lock';
import {
  DAILY_PASS_PRICE_RAW,
  paymentClaimLockKey,
  preauthorizeSpending,
  settleVerifiedTransfer,
  userPaymentLockKey,
} from './subscription.service';
import { verifyUsdcTransfer, VerifiedTransfer } from './payment-verification.service';

export interface PaymentIntentView {
  id: string;
  status: PaymentIntentStatus;
  type: SubscriptionType;
  amountRaw: string;
  currency: SettlementCurrency;
  recipient: string;
  token: string;
  memo: string;
  nonce: string;
  txHash: string | null;
  subscriptionId: string | null;
  paymentEventId: string | null;
  overpaymentRaw: string | null;
  underpaymentRaw: string | null;
  latePayment: boolean;
  refundRequired: boolean;
  attempts: number;
  expiresAt: Date;
  confirmedAt: Date | null;
  createdAt: Date;
}

function view(intent: any): PaymentIntentView {
  return {
    ...intent,
    amountRaw: intent.amountRaw.toString(),
    overpaymentRaw: intent.overpaymentRaw?.toString() ?? null,
    underpaymentRaw: intent.underpaymentRaw?.toString() ?? null,
  };
}

function retryDelayMs(attempts: number): number {
  const base = config.PAYMENT_INTENT_RETRY_BASE_MS;
  return Math.min(config.PAYMENT_INTENT_RETRY_MAX_MS, base * 2 ** Math.min(attempts, 10));
}

/** Creates a server-priced daily-pass intent (#52). */
export async function createPaymentIntent(userId: string, walletAddress: string): Promise<{
  intent: PaymentIntentView;
  allowance: Awaited<ReturnType<typeof preauthorizeSpending>>;
}> {
  const now = new Date();
  const open = await prisma.paymentIntent.count({
    where: {
      userId,
      status: { in: [PaymentIntentStatus.OPEN, PaymentIntentStatus.PENDING_PAYMENT] },
      expiresAt: { gt: now },
    },
  });
  if (open >= config.PAYMENT_INTENT_MAX_OPEN) {
    throw new AppError(429, 'TOO_MANY_PAYMENT_INTENTS', 'Too many open payment intents; submit or let them expire first');
  }

  const nonce = randomBytes(16).toString('hex');
  const memo = `od-${nonce.slice(0, 24)}`;
  const allowance = await preauthorizeSpending(userId, 'DAILY_PASS', DAILY_PASS_PRICE_RAW, now);
  const intent = await prisma.paymentIntent.create({
    data: {
      userId,
      walletAddress,
      type: SubscriptionType.DAILY_PASS,
      amountRaw: DAILY_PASS_PRICE_RAW.toString(),
      currency: SettlementCurrency.USDC,
      recipient: PAYMENTS_RECIPIENT,
      token: CONTRACTS.usdc,
      memo,
      nonce,
      expiresAt: new Date(now.getTime() + config.PAYMENT_INTENT_TTL_SECONDS * 1000),
    },
  });
  return { intent: view(intent), allowance };
}

export async function getPaymentIntent(userId: string, id: string): Promise<PaymentIntentView> {
  const intent = await prisma.paymentIntent.findUnique({ where: { id } });
  if (!intent || intent.userId !== userId) {
    throw new AppError(404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found');
  }
  return view(intent);
}

async function existingHashReplay(
  tx: Prisma.TransactionClient,
  txHash: string,
  intent: { id: string; userId: string },
): Promise<boolean> {
  const event = await tx.paymentEvent.findUnique({ where: { txHash } });
  if (!event) return false;
  if (event.userId === intent.userId && event.paymentIntentId === intent.id) return true;
  throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This payment has already been used');
}

async function recordUnappliedPayment(
  tx: Prisma.TransactionClient,
  params: {
    intent: { id: string; userId: string };
    transfer: VerifiedTransfer;
    reason: 'UNDERPAYMENT' | 'LATE_PAYMENT';
    underpaymentRaw?: bigint;
    latePayment?: boolean;
  },
): Promise<string> {
  const { intent, transfer } = params;
  const event = await tx.paymentEvent.create({
    data: {
      userId: intent.userId,
      txHash: transfer.txHash.toLowerCase(),
      type: PaymentEventType.DAILY_PASS,
      amount: toDisplayUsdc(transfer.amount),
      amountRaw: transfer.amount.toString(),
      fromAddress: transfer.from,
      currency: SettlementCurrency.USDC,
      status: PaymentEventStatus.CONFIRMED,
      ledger: transfer.ledger,
      ledgerCloseTime: ledgerCloseDate(transfer.createdAt),
      paymentIntentId: intent.id,
      confirmedAt: new Date(),
      metadata: {
        paymentIntentId: intent.id,
        reason: params.reason,
        underpaymentRaw: params.underpaymentRaw?.toString() ?? null,
        latePayment: params.latePayment ?? false,
        noCoverage: true,
      } as any,
    },
  });
  return event.id;
}

export type SubmitIntentResult =
  | { status: 'CONFIRMED'; intent: PaymentIntentView }
  | { status: 'PENDING_PAYMENT'; intent: PaymentIntentView }
  | { status: 'REFUND_REQUIRED'; intent: PaymentIntentView };

/**
 * Attaches a transaction hash to an intent and verifies/settles it. The same
 * path is used by the client and the background confirmer, so retries are
 * idempotent and a pending tx can be completed without another client action.
 */
export async function submitPaymentIntent(params: {
  userId: string;
  walletAddress: string;
  id: string;
  txHash: string;
}): Promise<SubmitIntentResult> {
  const { userId, walletAddress, id } = params;
  const txHash = params.txHash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'txHash must be a 64-character lowercase hex Stellar transaction hash');
  }

  const initial = await prisma.paymentIntent.findUnique({ where: { id } });
  if (!initial || initial.userId !== userId) {
    throw new AppError(404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found');
  }
  if (initial.status === PaymentIntentStatus.CONFIRMED) {
    return { status: 'CONFIRMED', intent: view(initial) };
  }
  if (initial.status === PaymentIntentStatus.REFUND_REQUIRED) {
    return { status: 'REFUND_REQUIRED', intent: view(initial) };
  }
  if (initial.status === PaymentIntentStatus.FAILED || initial.status === PaymentIntentStatus.EXPIRED) {
    throw new AppError(409, 'PAYMENT_INTENT_CLOSED', 'This payment intent is no longer open');
  }
  if (initial.txHash && initial.txHash !== txHash) {
    throw new AppError(409, 'PAYMENT_INTENT_TX_MISMATCH', 'A different transaction is already attached to this intent');
  }

  const claim = await withAdvisoryLocksWait(
    [paymentClaimLockKey(txHash), userPaymentLockKey(userId)],
    async (tx) => {
      const intent = await tx.paymentIntent.findUnique({ where: { id } });
      if (!intent || intent.userId !== userId) {
        throw new AppError(404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found');
      }
      if (intent.status === PaymentIntentStatus.CONFIRMED) {
        return { status: 'CONFIRMED' as const, intent: view(intent) };
      }
      if (intent.status === PaymentIntentStatus.REFUND_REQUIRED) {
        return { status: 'REFUND_REQUIRED' as const, intent: view(intent) };
      }
      if (intent.status === PaymentIntentStatus.FAILED || intent.status === PaymentIntentStatus.EXPIRED) {
        throw new AppError(409, 'PAYMENT_INTENT_CLOSED', 'This payment intent is no longer open');
      }
      if (intent.txHash && intent.txHash !== txHash) {
        throw new AppError(409, 'PAYMENT_INTENT_TX_MISMATCH', 'A different transaction is already attached to this intent');
      }
      if (await existingHashReplay(tx, txHash, intent)) {
        const settled = await tx.paymentIntent.findUnique({ where: { id } });
        return { status: 'CONFIRMED' as const, intent: view(settled) };
      }

      const now = new Date();
      const requiredRaw = decimalToBigint(intent.amountRaw);
      let transfer: VerifiedTransfer;
      try {
        transfer = await verifyUsdcTransfer({
          txHash,
          token: intent.token,
          from: walletAddress,
          to: intent.recipient,
          // Read the actual amount so underpayments can be recorded and routed
          // to manual review instead of vanishing behind a 402.
          minAmount: 0n,
          memo: { type: 'text', value: intent.memo },
        });
      } catch (err) {
        if (err instanceof AppError && err.code === 'PAYMENT_NOT_FOUND') {
          const attempts = intent.attempts + 1;
          const pending = await tx.paymentIntent.update({
            where: { id },
            data: {
              status: PaymentIntentStatus.PENDING_PAYMENT,
              txHash,
              submittedAt: intent.submittedAt ?? now,
              attempts: { increment: 1 },
              nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
              failureCode: 'PAYMENT_NOT_FOUND',
            },
          });
          return { status: 'PENDING_PAYMENT' as const, intent: view(pending) };
        }
        if (err instanceof AppError && err.code === 'PAYMENT_FAILED') {
          await tx.paymentIntent.update({
            where: { id },
            data: { status: PaymentIntentStatus.FAILED, txHash, failureCode: err.code, nextAttemptAt: null },
          });
        }
        throw err;
      }

      const closeAt = ledgerCloseDate(transfer.createdAt) ?? now;
      const late = closeAt.getTime() > intent.expiresAt.getTime();
      const underpaymentRaw = transfer.amount < requiredRaw ? requiredRaw - transfer.amount : 0n;
      const overpaymentRaw = transfer.amount > requiredRaw ? transfer.amount - requiredRaw : 0n;

      if (late || underpaymentRaw > 0n) {
        const eventId = await recordUnappliedPayment(tx, {
          intent,
          transfer,
          reason: late ? 'LATE_PAYMENT' : 'UNDERPAYMENT',
          underpaymentRaw,
          latePayment: late,
        });
        const updated = await tx.paymentIntent.update({
          where: { id },
          data: {
            status: PaymentIntentStatus.REFUND_REQUIRED,
            txHash,
            paymentEventId: eventId,
            underpaymentRaw: underpaymentRaw > 0n ? underpaymentRaw.toString() : null,
            overpaymentRaw: overpaymentRaw > 0n ? overpaymentRaw.toString() : null,
            latePayment: late,
            refundRequired: true,
            expiredAt: late ? intent.expiresAt : null,
            confirmedAt: null,
            nextAttemptAt: null,
            failureCode: late ? 'LATE_PAYMENT' : 'UNDERPAYMENT',
          },
        });
        return { status: 'REFUND_REQUIRED' as const, intent: view(updated) };
      }

      const settlement = await settleVerifiedTransfer(tx, {
        userId,
        type: 'DAILY_PASS',
        transfer,
        paymentIntentId: intent.id,
      });
      const updated = await tx.paymentIntent.update({
        where: { id },
        data: {
          status: PaymentIntentStatus.CONFIRMED,
          txHash,
          subscriptionId: settlement.subscription.id,
          paymentEventId: settlement.paymentEventId,
          overpaymentRaw: overpaymentRaw > 0n ? overpaymentRaw.toString() : null,
          underpaymentRaw: null,
          latePayment: false,
          refundRequired: false,
          confirmedAt: new Date(),
          nextAttemptAt: null,
          failureCode: null,
        },
      });
      return { status: 'CONFIRMED' as const, intent: view(updated) };
    },
    { waitMs: 30_000, timeoutMs: 60_000 },
  );

  if (!claim.acquired) {
    throw new AppError(409, 'PAYMENT_CLAIM_IN_PROGRESS', 'This payment is being processed; retry shortly');
  }
  logger.info({ intentId: id, status: claim.value.status, txHash }, 'Payment intent submission processed');
  return claim.value;
}

/**
 * Bounded background sweep: retries pending transactions with backoff and
 * expires intents that never received a transaction. Every state transition is
 * conditional/idempotent; the advisory lock in submitPaymentIntent prevents
 * double settlement.
 */
export async function confirmPendingPaymentIntents(now = new Date()): Promise<{ checked: number; expired: number }> {
  const staleBefore = new Date(now.getTime() - config.PAYMENT_INTENT_LATE_GRACE_SECONDS * 1000);
  const expired = await prisma.paymentIntent.updateMany({
    where: {
      status: { in: [PaymentIntentStatus.OPEN, PaymentIntentStatus.PENDING_PAYMENT] },
      txHash: null,
      expiresAt: { lt: staleBefore },
    },
    data: { status: PaymentIntentStatus.EXPIRED, expiredAt: now, nextAttemptAt: null, failureCode: 'EXPIRED' },
  });

  const pending = await prisma.paymentIntent.findMany({
    where: {
      status: PaymentIntentStatus.PENDING_PAYMENT,
      txHash: { not: null },
      nextAttemptAt: { lte: now },
      attempts: { lt: config.PAYMENT_INTENT_MAX_ATTEMPTS },
      expiresAt: { gt: staleBefore },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: config.PAYMENT_INTENT_CONFIRM_BATCH,
  });

  let checked = 0;
  for (const intent of pending) {
    if (!intent.txHash) continue;
    checked++;
    try {
      await submitPaymentIntent({
        userId: intent.userId,
        walletAddress: intent.walletAddress,
        id: intent.id,
        txHash: intent.txHash,
      });
    } catch (err) {
      logger.warn({ err, intentId: intent.id }, 'Payment intent confirmation failed; will retry');
    }
  }

  const abandoned = await prisma.paymentIntent.updateMany({
    where: {
      status: PaymentIntentStatus.PENDING_PAYMENT,
      expiresAt: { lt: staleBefore },
      attempts: { gte: config.PAYMENT_INTENT_MAX_ATTEMPTS },
    },
    data: { status: PaymentIntentStatus.EXPIRED, expiredAt: now, nextAttemptAt: null, failureCode: 'NOT_CONFIRMED' },
  });

  if (checked > 0 || expired.count > 0 || abandoned.count > 0) {
    logger.info(
      { checked, expired: expired.count, abandoned: abandoned.count },
      'Payment intent sweep completed',
    );
  }
  return { checked, expired: expired.count + abandoned.count };
}
