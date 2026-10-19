SET lock_timeout = '5s';

-- Exact base-unit allowance accounting (#53). Float columns remain as display
-- mirrors for backwards compatibility; enforcement uses the NUMERIC(39,0)
-- columns below.
ALTER TABLE "spending_allowances"
    ADD COLUMN "dailyLimitRaw" NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN "perTraceLimitRaw" NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN "spentTodayRaw" NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN "overageRaw" NUMERIC(39,0) NOT NULL DEFAULT 0,
    ADD COLUMN "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "spending_allowances"
SET
    "dailyLimitRaw" = ROUND("dailyLimit"::numeric * 10000000)::numeric(39,0),
    "perTraceLimitRaw" = ROUND("perTraceLimit"::numeric * 10000000)::numeric(39,0),
    "spentTodayRaw" = CASE
        WHEN ("lastResetAt" AT TIME ZONE 'UTC')::date < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN 0
        ELSE ROUND("spentToday"::numeric * 10000000)::numeric(39,0)
    END,
    "overageRaw" = 0,
    "windowStartedAt" = date_trunc('day', "lastResetAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

UPDATE "spending_allowances"
SET "spentToday" = 0
WHERE "spentTodayRaw" = 0
  AND ("lastResetAt" AT TIME ZONE 'UTC')::date < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;

ALTER TABLE "payment_events"
    ADD COLUMN "ledger" INTEGER,
    ADD COLUMN "ledgerCloseTime" TIMESTAMP(3),
    ADD COLUMN "allowanceOverage" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "allowanceOverageRaw" NUMERIC(39,0);
