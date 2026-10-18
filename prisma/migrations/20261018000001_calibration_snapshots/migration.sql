-- #68 calibration: daily snapshot table and the composite index behind the
-- trace/market extraction join. Forward-only; no data to backfill.
-- The reasoning_traces index is built without CONCURRENTLY (Prisma runs each
-- migration in a transaction); see prisma/migration-allowlist.json.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "calibration_snapshots" (
    "id" TEXT NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "window" TEXT NOT NULL,
    "groupBy" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "calibration_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calibration_snapshots_window_groupBy_computedAt_idx" ON "calibration_snapshots"("window", "groupBy", "computedAt");

-- CreateIndex
CREATE INDEX "reasoning_traces_marketId_createdAt_idx" ON "reasoning_traces"("marketId", "createdAt");
