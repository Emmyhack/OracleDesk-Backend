SET lock_timeout = '5s';

-- Daily-pass coverage anchored to the payment ledger's close time (#54).
ALTER TABLE "subscriptions"
    ADD COLUMN "purchaseLedger" INTEGER,
    ADD COLUMN "startsAt" TIMESTAMP(3),
    ADD COLUMN "endsAt" TIMESTAMP(3);

-- Legacy daily passes bought from claim time: preserve their existing window.
UPDATE "subscriptions"
SET
    "startsAt" = COALESCE("expiresAt" - INTERVAL '24 hours', "createdAt"),
    "endsAt" = COALESCE("expiresAt", "createdAt" + INTERVAL '24 hours')
WHERE "type" = 'DAILY_PASS';

-- Per-trace unlocks are point purchases; keep the historical bounds explicit.
UPDATE "subscriptions"
SET
    "startsAt" = "createdAt",
    "endsAt" = "expiresAt"
WHERE "type" = 'PER_TRACE';

CREATE INDEX "subscriptions_userId_status_endsAt_idx"
    ON "subscriptions"("userId", "status", "endsAt");
