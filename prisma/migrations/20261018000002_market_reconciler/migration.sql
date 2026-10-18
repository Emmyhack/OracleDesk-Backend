-- #83 market lifecycle reconciler
SET lock_timeout = '5s';

ALTER TABLE "markets" ADD COLUMN "chainSyncedLedger" INTEGER;
ALTER TABLE "markets" ADD COLUMN "lastReconciledAt" TIMESTAMPTZ(3);
CREATE INDEX "markets_lastReconciledAt_idx" ON "markets"("lastReconciledAt");

CREATE TABLE "market_drift_reports" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "onChainMarketId" BIGINT NOT NULL,
    "driftClass" TEXT NOT NULL,
    "dbValue" JSONB NOT NULL,
    "chainValue" JSONB NOT NULL,
    "action" TEXT NOT NULL,
    "observedLedger" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_drift_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "market_drift_reports_runId_idx" ON "market_drift_reports"("runId");
CREATE INDEX "market_drift_reports_driftClass_createdAt_idx" ON "market_drift_reports"("driftClass", "createdAt");

CREATE TABLE "reconcile_runs" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "repaired" INTEGER NOT NULL DEFAULT 0,
    "reported" INTEGER NOT NULL DEFAULT 0,
    "deferred" INTEGER NOT NULL DEFAULT 0,
    "rpcCalls" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "reconcile_runs_pkey" PRIMARY KEY ("id")
);
