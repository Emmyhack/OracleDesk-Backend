-- #38 fee bump: transaction outbox + inner/outer hash tracking
SET lock_timeout = '5s';

-- Outbox. Every live write persists its signed inner envelope before sending.
CREATE TABLE "chain_transactions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT,
    "hash" TEXT NOT NULL,
    "envelopeXdr" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "submitLedger" INTEGER,
    "maxTime" BIGINT,
    "innerFee" TEXT,
    "resourceFee" TEXT,
    "feeBumpHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "feeBumpEnvelopes" JSONB,
    "landedHash" TEXT,
    "bumpAttempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chain_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chain_transactions_hash_key" ON "chain_transactions"("hash");
CREATE INDEX "chain_transactions_status_idx" ON "chain_transactions"("status");
CREATE INDEX "chain_transactions_landedHash_idx" ON "chain_transactions"("landedHash");
CREATE INDEX "chain_transactions_kind_refId_idx" ON "chain_transactions"("kind", "refId");
CREATE INDEX "chain_transactions_feeBumpHashes_idx" ON "chain_transactions" USING GIN ("feeBumpHashes");

-- Domain rows store both hashes: the landed (outer when bumped) and the inner.
ALTER TABLE "markets" ADD COLUMN "creationInnerTxHash" TEXT;
ALTER TABLE "trades" ADD COLUMN "innerTxHash" TEXT;
ALTER TABLE "reasoning_traces" ADD COLUMN "publishInnerTxHash" TEXT;
