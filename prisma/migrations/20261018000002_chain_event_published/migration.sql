-- Migration: 20261018000002_chain_event_published (#93)
-- chain_events.published records that an event reached the event bus. Rows
-- that exist today were already delivered (or predate the bus), so the column
-- is added with DEFAULT true, which is metadata-only, and the default is then
-- switched to false for new rows. This avoids rewriting the table and avoids
-- re-publishing history.
SET lock_timeout = '5s';

ALTER TABLE "chain_events" ADD COLUMN "published" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "chain_events" ALTER COLUMN "published" SET DEFAULT false;

CREATE INDEX "chain_events_published_ledger_idx" ON "chain_events"("published", "ledger");
