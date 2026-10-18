-- Migration: 20261018000004_dispute_reviews (#92)
-- dispute_reviews: one independent review per ResolutionProposed event.
-- alert_deliveries: alerts sent for a review, unique per (review, level, sink).
SET lock_timeout = '5s';

CREATE TABLE "dispute_reviews" (
    "id" TEXT NOT NULL,
    "onChainMarketId" BIGINT NOT NULL,
    "proposalEventId" TEXT NOT NULL,
    "proposedOutcome" TEXT NOT NULL,
    "proposedAt" BIGINT,
    "windowEndsAt" BIGINT,
    "verdict" TEXT NOT NULL,
    "independentOutcome" TEXT,
    "confidence" DOUBLE PRECISION,
    "evidence" JSONB,
    "evidenceHash" TEXT,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispute_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dispute_reviews_proposalEventId_key" ON "dispute_reviews"("proposalEventId");
CREATE INDEX "dispute_reviews_verdict_idx" ON "dispute_reviews"("verdict");
CREATE INDEX "dispute_reviews_onChainMarketId_idx" ON "dispute_reviews"("onChainMarketId");

CREATE TABLE "alert_deliveries" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "sink" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alert_deliveries_dedupeKey_key" ON "alert_deliveries"("dedupeKey");
CREATE INDEX "alert_deliveries_reviewId_idx" ON "alert_deliveries"("reviewId");
