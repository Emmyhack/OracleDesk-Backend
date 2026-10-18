-- #66 LLM provenance. Forward-only, nullable, no backfill: rows created before
-- this migration simply have no provenance.
SET lock_timeout = '5s';

ALTER TABLE "markets" ADD COLUMN "generationProvenance" JSONB;
ALTER TABLE "reasoning_traces" ADD COLUMN "provenance" JSONB;
