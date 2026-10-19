-- Migration: 20261019000002_market_creation_attempts (#41)
-- Idempotent market creation attempts, claims, and discovery across ambiguous outcomes.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "market_creation_attempts" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "claim_lease_expires_at" TIMESTAMP(3),
    "question_hash" TEXT,
    "resolution_hash" TEXT,
    "pre_submission_market_count" BIGINT,
    "post_submission_market_count" BIGINT,
    "tx_hash" TEXT,
    "on_chain_market_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_creation_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "market_creation_attempts_market_id_key" UNIQUE ("market_id"),
    CONSTRAINT "market_creation_attempts_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "market_creation_attempts_question_hash_idx" ON "market_creation_attempts"("question_hash");
CREATE INDEX IF NOT EXISTS "market_creation_attempts_status_claimed_at_idx" ON "market_creation_attempts"("status", "claimed_at");
