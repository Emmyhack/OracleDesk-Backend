-- Migration: 20261018000003_signer_attestations (#91)
-- signer_attestations: attest transactions prepared and submitted for external
-- resolution signers. markets.resolutionSpec gets a GIN index so "markets whose
-- committed signer set contains this wallet" is an indexed JSONB containment.
SET lock_timeout = '5s';

CREATE TABLE "signer_attestations" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "onChainMarketId" BIGINT NOT NULL,
    "signer" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "preparedXdr" TEXT NOT NULL,
    "preparedHash" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT,
    "ledger" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signer_attestations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signer_attestations_onChainMarketId_signer_outcome_key"
    ON "signer_attestations"("onChainMarketId", "signer", "outcome");
CREATE INDEX "signer_attestations_marketId_idx" ON "signer_attestations"("marketId");

-- The markets table is small (one row per market), so a plain build is fine.
CREATE INDEX "markets_resolutionSpec_idx" ON "markets" USING GIN ("resolutionSpec");
