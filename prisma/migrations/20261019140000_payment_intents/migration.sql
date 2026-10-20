SET lock_timeout = '5s';

CREATE TYPE "PaymentIntentStatus" AS ENUM (
    'OPEN',
    'PENDING_PAYMENT',
    'CONFIRMED',
    'FAILED',
    'EXPIRED',
    'REFUND_REQUIRED'
);

ALTER TABLE "subscriptions"
    ADD COLUMN "paymentIntentId" TEXT;
CREATE UNIQUE INDEX "subscriptions_paymentIntentId_key" ON "subscriptions"("paymentIntentId");

ALTER TABLE "payment_events"
    ADD COLUMN "paymentIntentId" TEXT;
CREATE UNIQUE INDEX "payment_events_paymentIntentId_key" ON "payment_events"("paymentIntentId");

CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'OPEN',
    "type" "SubscriptionType" NOT NULL DEFAULT 'DAILY_PASS',
    "amountRaw" NUMERIC(39,0) NOT NULL,
    "currency" "SettlementCurrency" NOT NULL DEFAULT 'USDC',
    "recipient" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "txHash" TEXT,
    "subscriptionId" TEXT,
    "paymentEventId" TEXT,
    "overpaymentRaw" NUMERIC(39,0),
    "underpaymentRaw" NUMERIC(39,0),
    "latePayment" BOOLEAN NOT NULL DEFAULT false,
    "refundRequired" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_intents_memo_key" ON "payment_intents"("memo");
CREATE UNIQUE INDEX "payment_intents_nonce_key" ON "payment_intents"("nonce");
CREATE UNIQUE INDEX "payment_intents_txHash_key" ON "payment_intents"("txHash");
CREATE UNIQUE INDEX "payment_intents_subscriptionId_key" ON "payment_intents"("subscriptionId");
CREATE UNIQUE INDEX "payment_intents_paymentEventId_key" ON "payment_intents"("paymentEventId");
CREATE INDEX "payment_intents_userId_status_idx" ON "payment_intents"("userId", "status");
CREATE INDEX "payment_intents_status_nextAttemptAt_idx" ON "payment_intents"("status", "nextAttemptAt");
CREATE INDEX "payment_intents_expiresAt_idx" ON "payment_intents"("expiresAt");
