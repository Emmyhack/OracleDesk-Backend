-- Migration: 20261019020000_signal_store (#73)
-- Normalised signals with stable identities and near-duplicate clusters, a log
-- of provider calls, and raw provider payloads with bounded retention. Replaces
-- signal_cache, which is no longer written (dropped in a follow-up migration).
--
-- reasoning_traces.sourcesUsed gets a GIN (jsonb_path_ops) index so the
-- retention job's `sourcesUsed @> '[{"signalId": …}]'` probe for "is this
-- signal cited by a trace" is an index lookup, not a scan of every trace.
SET lock_timeout = '5s';

CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "externalId" TEXT,
    "url" TEXT,
    "publisher" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenCount" INTEGER NOT NULL DEFAULT 1,
    "category" "MarketCategory",
    "categoryConfidence" DOUBLE PRECISION,
    "clusterId" TEXT,
    "numericValue" DOUBLE PRECISION,
    "simhash" BIGINT,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signals_dedupKey_key" ON "signals"("dedupKey");
CREATE INDEX "signals_publishedAt_idx" ON "signals"("publishedAt");
CREATE INDEX "signals_clusterId_idx" ON "signals"("clusterId");
CREATE INDEX "signals_source_lastSeenAt_idx" ON "signals"("source", "lastSeenAt");
CREATE INDEX "signals_category_publishedAt_idx" ON "signals"("category", "publishedAt");

CREATE TABLE "signal_fetches" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "rawPayloadId" TEXT,

    CONSTRAINT "signal_fetches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "signal_fetches_source_startedAt_idx" ON "signal_fetches"("source", "startedAt");
CREATE INDEX "signal_fetches_startedAt_idx" ON "signal_fetches"("startedAt");

CREATE TABLE "signal_raw_payloads" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_raw_payloads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "signal_raw_payloads_createdAt_idx" ON "signal_raw_payloads"("createdAt");

CREATE INDEX "reasoning_traces_sourcesUsed_idx" ON "reasoning_traces" USING GIN ("sourcesUsed" jsonb_path_ops);
