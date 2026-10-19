-- Migration: 20261019000000_chain_fees (#39)
-- On-chain fee records per transaction hash for inclusion, resource and charged fee accounting.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "chain_fees" (
    "tx_hash" TEXT NOT NULL,
    "op_class" TEXT NOT NULL,
    "inclusion_fee" BIGINT NOT NULL,
    "resource_fee" BIGINT NOT NULL,
    "total_fee" BIGINT NOT NULL,
    "fee_charged" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_fees_pkey" PRIMARY KEY ("tx_hash")
);

CREATE INDEX IF NOT EXISTS "chain_fees_op_class_created_at_idx" ON "chain_fees"("op_class", "created_at");
