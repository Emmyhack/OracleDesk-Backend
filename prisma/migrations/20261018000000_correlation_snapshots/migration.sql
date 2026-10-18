-- #80 empirical market correlations
SET lock_timeout = '5s';

-- Per-market YES-price series come from Trade/MarketCreated/MarketResolved events.
CREATE INDEX "chain_events_trade_market_ledger"
  ON "chain_events" (((params->>'market_id')::numeric), "ledger")
  WHERE "contractName" = 'marketCore' AND "eventName" IN ('Trade', 'MarketCreated', 'MarketResolved');

CREATE TABLE "correlation_snapshots" (
    "id" TEXT NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gridStepSecs" INTEGER NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "pairs" JSONB NOT NULL,

    CONSTRAINT "correlation_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "correlation_snapshots_computedAt_idx" ON "correlation_snapshots"("computedAt");
