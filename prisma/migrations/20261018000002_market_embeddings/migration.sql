-- #69 semantic dedup: pgvector, a question embedding per market and an HNSW
-- cosine index. Requires a Postgres with the pgvector extension available
-- (the pgvector/pgvector:pg16 image, or CREATE EXTENSION vector on a managed
-- provider). The column is vector(768); EMBEDDING_DIM must match it.
--
-- Prisma cannot read or write Unsupported columns, so all access goes through
-- $queryRaw / $executeRaw with bound parameters. `prisma migrate dev` must not
-- drop the index: it is not expressible in schema.prisma (see docs/architecture.md).
SET lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "markets" ADD COLUMN "questionEmbedding" vector(768);
ALTER TABLE "markets" ADD COLUMN "embeddingModel" TEXT;

-- HNSW ignores NULL vectors, so rows without an embedding simply are not in it.
-- It is partial on the markets dedup compares against. pgvector applies WHERE
-- filters after the index scan, so a full index would fill its candidate list
-- (hnsw.ef_search, 40 by default) with old RESOLVED markets and hide a near
-- duplicate among the active ones. Rows leave the index when they resolve.
-- The dedup query repeats the predicate, which is what lets the planner use it.
CREATE INDEX "markets_question_embedding_hnsw" ON "markets" USING hnsw ("questionEmbedding" vector_cosine_ops)
  WHERE status IN ('PENDING', 'ACTIVE');
