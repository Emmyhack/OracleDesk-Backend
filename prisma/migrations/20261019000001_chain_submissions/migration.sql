-- Migration: 20261019000001_chain_submissions (#42)
-- Explicit timebounds, auth expiration, and expiry decision tracking per submission.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "chain_submissions" (
    "tx_hash" TEXT NOT NULL,
    "op_class" TEXT NOT NULL,
    "min_time" BIGINT NOT NULL DEFAULT 0,
    "max_time" BIGINT NOT NULL,
    "auth_expiration_ledger" INTEGER,
    "submitted_ledger" INTEGER,
    "submitted_at_close_time" BIGINT,
    "decision" TEXT NOT NULL,
    "rebuild_count" INTEGER NOT NULL DEFAULT 0,
    "attempt_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_submissions_pkey" PRIMARY KEY ("tx_hash")
);

CREATE INDEX IF NOT EXISTS "chain_submissions_op_class_created_at_idx" ON "chain_submissions"("op_class", "created_at");
CREATE INDEX IF NOT EXISTS "chain_submissions_attempt_id_idx" ON "chain_submissions"("attempt_id");
