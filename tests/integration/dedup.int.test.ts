/**
 * Semantic dedup against a real pgvector (#69): the migration, vector writes
 * through bound parameters, the cosine KNN query and its HNSW index.
 * Needs a Postgres with the vector extension (the pgvector/pgvector:pg16 image).
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationEnv, skipReason } from './setup';

let db: Awaited<ReturnType<typeof integrationEnv>>;
let prisma: import('@prisma/client').PrismaClient;
let truncateAll: typeof import('../helpers/db').truncateAll;
let emb: typeof import('../../src/services/embeddings.service');
let market: typeof import('../../src/services/market.service');

before(async () => {
  db = await integrationEnv('dedup');
  if (!db) return;
  prisma = (await import('../../src/lib/prisma')).prisma;
  truncateAll = (await import('../helpers/db')).truncateAll;
  emb = await import('../../src/services/embeddings.service');
  market = await import('../../src/services/market.service');
});
beforeEach(async () => { if (db) { await truncateAll(prisma); emb.resetEmbeddingProvider(); } });
after(async () => { if (db) { emb?.resetEmbeddingProvider(); await prisma.$disconnect(); await db.drop(); } });

const unit = (seed: number): number[] => {
  const v = Array.from({ length: 768 }, (_, i) => Math.sin(seed * 12.9898 + i * 78.233));
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
};

async function insert(question: string, over: { status?: string; expiry?: string; category?: string } = {}) {
  return prisma.market.create({
    data: {
      question,
      category: (over.category ?? 'FED') as never,
      status: (over.status ?? 'PENDING') as never,
      initialYesProb: 0.5,
      confidenceInterval: { lower: 0.4, upper: 0.6 },
      expiryTimestamp: new Date(over.expiry ?? '2026-09-17T12:00:00Z'),
    },
  });
}

async function setVector(id: string, v: number[], model: string) {
  const { Prisma } = await import('@prisma/client');
  await prisma.$executeRaw(Prisma.sql`UPDATE markets SET "questionEmbedding" = ${emb.toVectorLiteral(v)}::vector, "embeddingModel" = ${model} WHERE id = ${id}`);
}

test('the migration enables pgvector, adds the vector(768) column and an HNSW cosine index', { skip: skipReason() }, async () => {
  const ext = await prisma.$queryRaw<Array<{ extname: string }>>`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
  assert.equal(ext.length, 1);
  const col = await prisma.$queryRaw<Array<{ type: string }>>`
    SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
    WHERE a.attrelid = 'markets'::regclass AND a.attname = 'questionEmbedding'`;
  assert.equal(col[0].type, 'vector(768)');
  const idx = await prisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef FROM pg_indexes WHERE indexname = 'markets_question_embedding_hnsw'`;
  assert.match(idx[0].indexdef, /USING hnsw \("questionEmbedding" vector_cosine_ops\)/);
  assert.match(idx[0].indexdef, /WHERE .*PENDING.*ACTIVE/, 'partial on the markets dedup compares against');
});

test('the KNN query returns the nearest PENDING/ACTIVE rows of the same model, best first', { skip: skipReason() }, async () => {
  const base = unit(1);
  const near = base.map((x, i) => x * 0.95 + unit(2)[i] * 0.05);
  const far = unit(3);
  const [a, b, c, resolved, otherModel, nullVec] = await Promise.all([
    insert('near'), insert('far'), insert('identical'), insert('resolved', { status: 'RESOLVED' }), insert('other model'), insert('no vector'),
  ]);
  await setVector(a.id, near, 'm1');
  await setVector(b.id, far, 'm1');
  await setVector(c.id, base, 'm1');
  await setVector(resolved.id, base, 'm1');
  await setVector(otherModel.id, base, 'other');
  void nullVec;

  const hits = await emb.postgresVectorIndex.nearest(base, 'm1', 10);
  assert.deepEqual(hits.map((h) => h.question), ['identical', 'near', 'far']);
  assert.ok(Math.abs(hits[0].similarity - 1) < 1e-5);
  assert.ok(hits[1].similarity > 0.99 && hits[1].similarity < 1);
  assert.ok(hits[2].similarity < hits[1].similarity);
  assert.ok(Math.abs(hits[0].similarity - emb.cosine(base, base)) < 1e-5);
  assert.equal((await emb.postgresVectorIndex.nearest(base, 'm1', 1)).length, 1);

  const unseen = await emb.postgresVectorIndex.unembedded('m1');
  assert.deepEqual(unseen.map((u) => u.question).sort(), ['no vector', 'other model']);
});

test('the nearest-neighbour query uses the HNSW index', { skip: skipReason() }, async () => {
  await prisma.$executeRawUnsafe(`
    INSERT INTO markets (id, question, category, status, "settlementCurrency", "initialYesProb", "confidenceInterval", "expiryTimestamp", "questionEmbedding", "embeddingModel", "updatedAt")
    SELECT 'v' || g, 'q' || g, 'FED', 'PENDING', 'USDC', 0.5, '{"lower":0.4,"upper":0.6}', now(),
           (SELECT array_agg(random())::vector FROM generate_series(1, 768) WHERE g > 0), 'm1', now()
    FROM generate_series(1, 300) g`);
  await prisma.$executeRawUnsafe('ANALYZE markets');
  const { Prisma } = await import('@prisma/client');
  const literal = emb.toVectorLiteral(unit(5));
  const plan = await prisma.$transaction(async (tx) => {
    // At a few hundred rows the planner (rightly) prefers an exact scan and sort,
    // which also has perfect recall. Turning those paths off shows the query shape
    // can use the partial HNSW index, which is what matters once the table grows.
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
    await tx.$executeRawUnsafe('SET LOCAL enable_sort = off');
    const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(Prisma.sql`
      EXPLAIN SELECT id, 1 - ("questionEmbedding" <=> ${literal}::vector) AS sim
      FROM markets WHERE status IN ('PENDING','ACTIVE') AND "questionEmbedding" IS NOT NULL AND "embeddingModel" = ${'m1'}
      ORDER BY "questionEmbedding" <=> ${literal}::vector LIMIT 10`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
  assert.match(plan.replace(/\[[^\]]*\]/g, '[…]'), /Index Scan using markets_question_embedding_hnsw/, plan.replace(/\[[^\]]*\]/g, '[…]'));
});

test('embedMarket, checkDuplicate and backfillEmbeddings work end to end through real SQL', { skip: skipReason() }, async () => {
  emb.setEmbeddingProvider(emb.fakeEmbeddingProvider());
  const existing = await insert('Will the Federal Reserve keep the federal funds rate unchanged at its September meeting?');
  const other = await insert('Will Bitcoin trade above $100,000 before year end?', { category: 'CRYPTO', expiry: '2026-12-31T12:00:00Z' });

  // not embedded yet: nothing for the vector search to see, the lexical pass still catches it
  const early = await market.checkDuplicate({
    market_question: 'Will the Federal Reserve keep the federal funds rate unchanged at its September 17, 2026 meeting?',
    category: 'FED' as never, expiry_timestamp: Math.floor(Date.parse('2026-09-17T12:00:00Z') / 1000),
  });
  assert.deepEqual([early.duplicate, early.method, early.match?.marketId], [true, 'lexical', existing.id]);

  await emb.embedMarket(existing.id);
  const stored = await prisma.$queryRaw<Array<{ model: string; dims: number }>>`
    SELECT "embeddingModel" AS model, vector_dims("questionEmbedding") AS dims FROM markets WHERE id = ${existing.id}`;
  assert.deepEqual([stored[0].model, stored[0].dims], ['fake-hash-v1', 768]);

  assert.deepEqual(await emb.backfillEmbeddings(10), { embedded: 1, failed: 0 }, 'only the still-NULL row');
  assert.deepEqual(await emb.backfillEmbeddings(10), { embedded: 0, failed: 0 });

  // embedded now: found by the vector search
  const q = 'Will the Federal Reserve keep the federal funds rate unchanged at its September 17th, 2026 meeting?';
  const late = await market.checkDuplicate({ market_question: q, category: 'FED' as never, expiry_timestamp: Math.floor(Date.parse('2026-09-17T12:00:00Z') / 1000) });
  assert.deepEqual([late.duplicate, late.method, late.match?.marketId], [true, 'semantic', existing.id]);
  assert.ok(late.match!.similarity > 0.95);

  // a different date is a different market
  const other1 = await market.checkDuplicate({ market_question: q.replace('September 17th', 'December 9'), category: 'FED' as never, expiry_timestamp: Math.floor(Date.parse('2026-12-09T12:00:00Z') / 1000) });
  assert.equal(other1.duplicate, false);
  void other;

  // re-embedding after a model change
  emb.setEmbeddingProvider(emb.fakeEmbeddingProvider(768, 'fake-hash-v2'));
  assert.deepEqual(await emb.backfillEmbeddings(10, { reembed: true }), { embedded: 2, failed: 0 });
  const models = await prisma.$queryRaw<Array<{ m: string }>>`SELECT DISTINCT "embeddingModel" AS m FROM markets`;
  assert.deepEqual(models.map((r) => r.m), ['fake-hash-v2']);
});
