-- #35 transactional outbox: every live write persists its signed envelope and
-- hash before submission and moves through an explicit state machine
-- (BUILT → SIGNED → SUBMITTED → PENDING → SUCCESS | FAILED | EXPIRED), with a
-- recovery worker resolving non-terminal rows after a crash.
SET lock_timeout = '5s';

-- chain_transactions landed with #38 (fee bumps) but nothing ever wired the
-- write path to it, so the table is empty in every deployment; the type
-- change and index below therefore rewrite and scan nothing.
CREATE TYPE "ChainTxStatus" AS ENUM ('BUILT', 'SIGNED', 'SUBMITTED', 'PENDING', 'SUCCESS', 'FAILED', 'EXPIRED');

-- #38's PENDING meant "signed envelope recorded, not yet known submitted",
-- which is SIGNED in the new state machine.
UPDATE "chain_transactions" SET "status" = 'SIGNED' WHERE "status" = 'PENDING';

ALTER TABLE "chain_transactions"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "ChainTxStatus" USING ("status"::"ChainTxStatus"),
  ALTER COLUMN "status" SET DEFAULT 'BUILT',
  -- A BUILT row exists before signing, so the envelope and hash arrive later.
  ALTER COLUMN "hash" DROP NOT NULL,
  ALTER COLUMN "envelopeXdr" DROP NOT NULL,
  ADD COLUMN "contract" TEXT,
  ADD COLUMN "method" TEXT,
  ADD COLUMN "args" JSONB,
  ADD COLUMN "simulated" JSONB,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "sequence" TEXT,
  -- Unix seconds, like the existing maxTime.
  ADD COLUMN "minTime" BIGINT,
  ADD COLUMN "ledger" INTEGER,
  ADD COLUMN "resultXdr" TEXT,
  ADD COLUMN "returnValue" JSONB,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "handledAt" TIMESTAMPTZ(3);

-- The recovery worker scans non-terminal rows oldest-first.
CREATE INDEX "chain_transactions_status_updatedAt_idx" ON "chain_transactions"("status", "updatedAt");
