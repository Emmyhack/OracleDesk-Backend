/**
 * Semantic dedup (#69): normalisation, the two-stage decision, the lexical
 * fallback and parameterised vector SQL. A scripted provider and an in-memory
 * VectorIndex stand in for Gemini/OpenAI and pgvector; the real index is
 * covered by tests/integration/dedup.int.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

process.env.GEMINI_API_KEY = '';
setupTestEnv();

type EmbSvc = typeof import('../src/services/embeddings.service');
const DIM = 768;
const unit = (seed: number): number[] => {
  const v = Array.from({ length: DIM }, (_, i) => Math.sin(seed * 12.9898 + i * 78.233));
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
};
/** A unit vector whose cosine with `base` is exactly `sim` (orthogonalised against base). */
function withSim(base: number[], sim: number, seed: number): number[] {
  const w = unit(seed);
  const dot = w.reduce((a, x, i) => a + x * base[i], 0);
  const orth = w.map((x, i) => x - dot * base[i]);
  const n = Math.sqrt(orth.reduce((a, x) => a + x * x, 0));
  const k = Math.sqrt(1 - sim * sim);
  return base.map((b, i) => sim * b + (k * orth[i]) / n);
}

/** Provider that returns scripted vectors for given questions (keyed by normalised text). */
async function scripted(table: Record<string, number[]>, over: Partial<{ fail: boolean }> = {}) {
  const emb: EmbSvc = await import('../src/services/embeddings.service');
  const calls: string[][] = [];
  const provider = {
    id: 'fake' as const, model: 'scripted', dim: DIM,
    async embed(texts: string[]) {
      calls.push(texts);
      if (over.fail) throw new Error('provider down');
      return texts.map((t) => table[t] ?? unit(t.length));
    },
  };
  return { emb, provider, calls, key: (q: string) => emb.normalizeQuestion(q) };
}

interface Row { id: string; question: string; category: string; expiryTimestamp: Date; vector: number[] | null; model: string }
function memoryIndex(emb: EmbSvc, rows: Row[]) {
  return {
    async nearest(vector: number[], model: string, k: number) {
      return rows.filter((r) => r.vector && r.model === model)
        .map((r) => ({ marketId: r.id, question: r.question, category: r.category, expiryTimestamp: r.expiryTimestamp, similarity: emb.cosine(vector, r.vector!) }))
        .sort((a, b) => b.similarity - a.similarity).slice(0, k);
    },
    async unembedded(model: string) {
      return rows.filter((r) => !r.vector || r.model !== model).map(({ id, question, category, expiryTimestamp }) => ({ id, question, category, expiryTimestamp }));
    },
  };
}

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const proposal = (q: string, due: string, category = 'FED') => ({ market_question: q, category: category as any, expiry_timestamp: Math.floor(day(due).getTime() / 1000) });

async function withDedup<T>(
  table: Record<string, number[]>, rows: Row[], fn: (ctx: Awaited<ReturnType<typeof scripted>>) => Promise<T>, over: { fail?: boolean } = {},
): Promise<T> {
  const ctx = await scripted(table, over);
  const { prisma } = await import('../src/lib/prisma');
  const orig = prisma.market.findMany;
  (prisma.market.findMany as any) = async () => rows.map((r) => ({ id: r.id, question: r.question }));
  ctx.emb.setEmbeddingProvider(ctx.provider);
  const prev = ctx.emb.setVectorIndex(memoryIndex(ctx.emb, rows) as any);
  try { return await fn(ctx); } finally {
    ctx.emb.setVectorIndex(prev);
    ctx.emb.resetEmbeddingProvider();
    (prisma.market.findMany as any) = orig;
  }
}

const FED_EXISTING = 'Will the Fed hold rates at its September meeting?';
const FED_NEW = 'Will the FOMC leave the federal funds target unchanged on Sept 17?';

// ─── decision ────────────────────────────────────────────────────────────────
test('paraphrased Fed hold questions are duplicates semantically, though the lexical check misses them', async () => {
  const { isDuplicateOf, checkDuplicate } = await import('../src/services/market.service');
  assert.equal(isDuplicateOf(FED_NEW, [FED_EXISTING]), false, 'little token overlap');
  const base = unit(1);
  const probe = await scripted({});
  const table = { [probe.key(FED_EXISTING)]: base, [probe.key(FED_NEW)]: withSim(base, 0.93, 2) };
  const rows: Row[] = [{ id: 'm1', question: FED_EXISTING, category: 'FED', expiryTimestamp: day('2026-09-17'), vector: base, model: 'scripted' }];
  await withDedup(table, rows, async () => {
    const r = await checkDuplicate(proposal(FED_NEW, '2026-09-17'));
    assert.equal(r.duplicate, true);
    assert.equal(r.method, 'semantic');
    assert.equal(r.match!.marketId, 'm1');
    assert.ok(Math.abs(r.match!.similarity - 0.93) < 1e-6);
    assert.match(r.match!.reason, /shared entities FED/);
  });
});

test('same subject on a different date is not a duplicate, however similar the vectors', async () => {
  const { checkDuplicate } = await import('../src/services/market.service');
  const base = unit(3);
  const q1 = 'Will Bitcoin close above $100,000 on October 31, 2026?';
  const q2 = 'Will Bitcoin close above $100,000 on December 31, 2026?';
  const q3 = 'Will BTC finish October 31, 2026 higher than $100,000?';
  const probe = await scripted({});
  // dates are normalised away, so the vectors really are (nearly) identical
  const table = { [probe.key(q1)]: base, [probe.key(q2)]: withSim(base, 0.99, 4), [probe.key(q3)]: withSim(base, 0.92, 8) };
  const rows: Row[] = [{ id: 'm1', question: q1, category: 'CRYPTO', expiryTimestamp: day('2026-10-31'), vector: base, model: 'scripted' }];
  await withDedup(table, rows, async () => {
    assert.equal((await checkDuplicate(proposal(q2, '2026-12-31', 'CRYPTO'))).duplicate, false);
    // the same day (one day of slack on the expiry) is the same market
    const near = await checkDuplicate(proposal(q3, '2026-11-01', 'CRYPTO'));
    assert.equal(near.duplicate, true);
    // a date written in the text beats a close expiry
    const mislabelled = await checkDuplicate(proposal(q2, '2026-11-01', 'CRYPTO'));
    assert.equal(mislabelled.duplicate, false);
  });
});

test('questions sharing boilerplate about different assets are not duplicates', async () => {
  const { checkDuplicate } = await import('../src/services/market.service');
  const base = unit(5);
  const a = 'Will Apple close above $250 by June 30, 2026?';
  const b = 'Will Tesla close above $250 by June 30, 2026?';
  const probe = await scripted({});
  const table = { [probe.key(a)]: base, [probe.key(b)]: withSim(base, 0.93, 6) };
  const rows: Row[] = [{ id: 'm1', question: a, category: 'MACRO', expiryTimestamp: day('2026-06-30'), vector: base, model: 'scripted' }];
  await withDedup(table, rows, async () => {
    const r = await checkDuplicate(proposal(b, '2026-06-30', 'MACRO'));
    assert.equal(r.duplicate, false);
    assert.equal(r.method, 'semantic');
  });
});

test('two rungs of a price ladder are not duplicates, but a re-worded threshold is', async () => {
  const { confirmDuplicate } = await import('../src/services/market.service');
  const exp = day('2026-10-31');
  const ladder = confirmDuplicate({ question: 'Will Bitcoin close above $70,000 on October 31?', expiry: exp }, { question: 'Will Bitcoin close above $90,000 on October 31?', expiry: exp, similarity: 0.97 });
  assert.equal(ladder.duplicate, false);
  assert.match(ladder.reason, /different figures/);
  const reworded = confirmDuplicate({ question: 'Will Bitcoin close above $70,000 on October 31?', expiry: exp }, { question: 'Will BTC finish October 31 higher than 70k?', expiry: exp, similarity: 0.9 });
  assert.equal(reworded.duplicate, true);
  const spx = confirmDuplicate({ question: 'Will the S&P 500 close above 6,500 on December 31?', expiry: day('2026-12-31') }, { question: 'Will the S&P 500 close above 7,500 on December 31?', expiry: day('2026-12-31'), similarity: 0.9 });
  assert.equal(spx.duplicate, false, 'the shared "500" must not mask different strikes');
});

test('very high similarity overrides an entity mismatch, but never a date or figure mismatch', async () => {
  const { confirmDuplicate, DEDUP_CERTAIN_SIM } = await import('../src/services/market.service');
  assert.equal(DEDUP_CERTAIN_SIM, 0.95);
  const exp = day('2026-11-30');
  const a = { question: 'Will Zorblax Holdings announce a merger?', expiry: exp };
  const b = { question: 'Will Quuxcorp Holdings announce a merger?', expiry: exp };
  const below = confirmDuplicate(a, { ...b, expiry: exp, similarity: 0.9 });
  assert.equal(below.duplicate, false, 'distinct unknown names conflict below 0.95');
  assert.match(below.reason, /different subjects/);
  const above = confirmDuplicate(a, { ...b, expiry: exp, similarity: 0.96 });
  assert.equal(above.duplicate, true);
  assert.match(above.reason, /0\.960 ≥ 0\.95/);
  assert.equal(confirmDuplicate(a, { ...b, expiry: day('2027-02-01'), similarity: 0.99 }).duplicate, false, 'date window still applies');

  const none = confirmDuplicate({ question: 'Will the merger close?', expiry: exp }, { question: 'Will the deal be completed?', expiry: exp, similarity: 0.9 });
  assert.equal(none.duplicate, false);
  assert.equal(none.reason, 'no shared entity');
});

test('dates written in both questions refine the expiry comparison', async () => {
  const { confirmDuplicate } = await import('../src/services/market.service');
  const exp = day('2026-10-30');
  const r = confirmDuplicate(
    { question: 'Will the BOJ raise rates on October 30?', expiry: exp },
    { question: 'Will the BOJ raise rates on October 5?', expiry: exp, similarity: 0.9 },
  );
  assert.equal(r.duplicate, false);
  assert.match(r.reason, /dates in the questions differ/);
});

// ─── fallbacks ───────────────────────────────────────────────────────────────
test('with no provider configured the lexical check runs and reports its method', async () => {
  const { checkDuplicate } = await import('../src/services/market.service');
  const emb: EmbSvc = await import('../src/services/embeddings.service');
  const { prisma } = await import('../src/lib/prisma');
  const orig = prisma.market.findMany;
  (prisma.market.findMany as any) = async () => [{ id: 'm1', question: 'Will the Federal Reserve keep the federal funds rate unchanged at its September meeting?' }];
  emb.setEmbeddingProvider(null);
  try {
    const dup = await checkDuplicate(proposal('Will the Federal Reserve keep the federal funds rate unchanged at its September 17, 2026 meeting?', '2026-09-17'));
    assert.equal(dup.duplicate, true);
    assert.equal(dup.method, 'lexical');
    assert.equal(dup.match!.marketId, 'm1');
    const fresh = await checkDuplicate(proposal('Will the ECB cut its deposit rate in December?', '2026-12-10', 'ECB'));
    assert.deepEqual(fresh, { duplicate: false, method: 'lexical' });
  } finally {
    emb.resetEmbeddingProvider();
    (prisma.market.findMany as any) = orig;
  }
});

test('an embedding failure falls back to the lexical check without throwing', async () => {
  const { checkDuplicate } = await import('../src/services/market.service');
  await withDedup({}, [{ id: 'm1', question: 'Will Bitcoin trade above $100,000 before year end?', category: 'CRYPTO', expiryTimestamp: day('2026-12-31'), vector: null, model: 'scripted' }], async () => {
    const r = await checkDuplicate(proposal('Will Bitcoin trade above $100,000 before year end 2026?', '2026-12-31', 'CRYPTO'));
    assert.equal(r.method, 'lexical');
    assert.equal(r.duplicate, true);
  }, { fail: true });
});

test('markets the vector index cannot see are compared lexically, not skipped', async () => {
  const { checkDuplicate } = await import('../src/services/market.service');
  const q = 'Will the Federal Reserve keep the federal funds rate unchanged at its September meeting?';
  const rows: Row[] = [
    { id: 'old', question: q, category: 'FED', expiryTimestamp: day('2026-09-17'), vector: null, model: 'scripted' },
    { id: 'other-model', question: 'Will the ECB hold rates in October?', category: 'ECB', expiryTimestamp: day('2026-10-29'), vector: unit(9), model: 'older-model' },
  ];
  await withDedup({}, rows, async () => {
    const r = await checkDuplicate(proposal('Will the Federal Reserve keep the federal funds rate unchanged at its September 17, 2026 meeting?', '2026-09-17'));
    assert.equal(r.duplicate, true);
    assert.equal(r.method, 'lexical');
    assert.equal(r.match!.marketId, 'old');
    assert.match(r.match!.reason, /no embedding yet/);
    assert.equal((await checkDuplicate(proposal('Will Mars have a crewed landing by 2030?', '2026-12-01', 'GEOPOLITICAL'))).duplicate, false);
  });
});

// ─── normalisation ───────────────────────────────────────────────────────────
test('normalizeQuestion is stable, canonicalises figures, drops dates and caps the length', async () => {
  const { normalizeQuestion, MAX_EMBED_CHARS } = await import('../src/services/embeddings.service');
  const samples = [
    'Will the Federal Reserve keep the federal funds rate unchanged at its September 17, 2026 meeting?',
    'Will BTC close above $70,000 by June 30, 2026?',
    'Will Bitcoin exceed 70k on 2026-10-01?',
    'Will the film open above $130 million on October 23-25, 2026?',
    'WILL   THE  U.S.  unemployment rate be above 4.5%???',
  ];
  for (const q of samples) {
    const n = normalizeQuestion(q);
    assert.equal(normalizeQuestion(n), n, `idempotent: ${q}`);
    assert.equal(n, n.toLowerCase());
  }
  assert.equal(normalizeQuestion('Will BTC close above $70,000 by June 30, 2026?'), normalizeQuestion('Will BTC close above 70k by 2026-06-30?'));
  assert.equal(normalizeQuestion('above $50 billion'), normalizeQuestion('above $50B'));
  assert.match(normalizeQuestion(samples[0]), /<date> meeting/);
  assert.equal(normalizeQuestion('Will the U.S. act?'), normalizeQuestion('Will the US act?'));
  const long = normalizeQuestion(`Will ${'x'.repeat(2000)} happen?`);
  assert.equal(long.length, MAX_EMBED_CHARS);
});

test('entity extraction maps aliases to one id and ignores words covered by a gazetteer form', async () => {
  const { extractEntities } = await import('../src/services/dedup-entities');
  assert.deepEqual([...extractEntities('Will the FOMC cut rates?')], ['FED']);
  assert.deepEqual([...extractEntities('Will the Federal Reserve cut rates?')], ['FED']);
  assert.ok(extractEntities('Will Bitcoin hit 100k?').has('BTC') && extractEntities('Will BTC hit 100k?').has('BTC'));
  assert.ok(extractEntities('Will the European Central Bank hold?').has('ECB'));
  assert.ok(extractEntities('Will the WHO declare an emergency?').has('HEALTH_EMERGENCY'));
  assert.ok(!extractEntities('Will anyone know who wins?').has('HEALTH_EMERGENCY'), 'the agency WHO is case-sensitive');
  assert.ok(extractEntities('Will the Lakers beat the Celtics?').has('NAME:lakers'));
});

// ─── vector SQL, providers, backfill ─────────────────────────────────────────
test('embedMarket writes the vector as a bound parameter, never interpolated', async () => {
  const emb: EmbSvc = await import('../src/services/embeddings.service');
  const { prisma } = await import('../src/lib/prisma');
  const vector = unit(7);
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  const orig = { find: prisma.market.findUnique, exec: prisma.$executeRaw };
  (prisma.market.findUnique as any) = async () => ({ question: 'Will Bitcoin trade above $100,000?' });
  (prisma.$executeRaw as any) = async (q: { sql: string; values: unknown[] }) => { executed.push({ sql: q.sql, values: q.values }); return 1; };
  emb.setEmbeddingProvider({ id: 'fake', model: 'scripted', dim: DIM, embed: async () => [vector] });
  try {
    await emb.embedMarket("m1'; DROP TABLE markets; --");
    assert.equal(executed.length, 1);
    assert.match(executed[0].sql, /SET "questionEmbedding" = \?::vector/, 'a placeholder, not a literal');
    assert.doesNotMatch(executed[0].sql, /DROP TABLE|0\.\d{4,}/, 'neither the id nor any vector component is in the SQL text');
    assert.equal(executed[0].values[0], emb.toVectorLiteral(vector));
    assert.equal(executed[0].values[1], 'scripted');
    assert.equal(executed[0].values[2], "m1'; DROP TABLE markets; --");
  } finally {
    emb.resetEmbeddingProvider();
    (prisma.market.findUnique as any) = orig.find;
    (prisma.$executeRaw as any) = orig.exec;
  }
});

test('toVectorLiteral and setEmbeddingProvider reject a dimension the column cannot hold', async () => {
  const emb: EmbSvc = await import('../src/services/embeddings.service');
  assert.throws(() => emb.toVectorLiteral([0.1, 0.2]), /768 finite numbers/);
  assert.throws(() => emb.toVectorLiteral(Array.from({ length: DIM }, () => NaN)), /finite/);
  assert.match(emb.toVectorLiteral(unit(1)), /^\[-?[\d.e-]+(,-?[\d.e-]+){767}\]$/);
  assert.throws(() => emb.setEmbeddingProvider({ id: 'fake', model: 'm', dim: 1536, embed: async () => [] }), /does not match vector\(768\)/);
});

test('the Gemini and OpenAI providers reject vectors of the wrong size', async () => {
  const emb: EmbSvc = await import('../src/services/embeddings.service');
  const gemini = await import('../src/lib/gemini');
  const { setSecretsForTest, SECRET_NAMES } = await import('../src/config/secrets');
  setSecretsForTest({ ...Object.fromEntries(SECRET_NAMES.map((n) => [n, ''])), GEMINI_API_KEY: 'test-key' } as any);
  let asked: any;
  const prev = gemini.setGenAI({
    getGenerativeModel: () => ({
      batchEmbedContents: async (req: any) => { asked = req; return { embeddings: [{ values: new Array(3).fill(0) }] }; },
    }),
  });
  try {
    const p = emb.geminiEmbeddingProvider('text-embedding-004', DIM);
    await assert.rejects(p.embed(['q']), /3-dimensional vector; expected 768/);
    assert.equal(asked.requests[0].outputDimensionality, DIM);
    assert.equal(asked.requests[0].content.parts[0].text, 'q');
  } finally {
    gemini.setGenAI(prev);
    setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, ''])) as any);
  }
});

test('the fake provider is deterministic, normalised and sensitive to wording', async () => {
  const emb: EmbSvc = await import('../src/services/embeddings.service');
  const p = emb.fakeEmbeddingProvider();
  const [a1, a2, b] = await p.embed(['Will the Fed hold rates?', 'Will the Fed hold rates?', 'Will the Lakers win the title?']);
  assert.deepEqual(a1, a2);
  assert.equal(a1.length, DIM);
  assert.ok(Math.abs(emb.cosine(a1, a1) - 1) < 1e-9);
  assert.ok(emb.cosine(a1, b) < 0.5);
  const [fomc] = await p.embed(['Will the FOMC keep rates unchanged?']);
  const [fed] = await p.embed(['Will the Fed hold rates steady?']);
  assert.ok(emb.cosine(fomc, fed) > 0.5, 'the synonym map brings paraphrases together');
});

test('backfillEmbeddings embeds each row, counts failures and leaves them for the next sweep', async () => {
  const emb: EmbSvc = await import('../src/services/embeddings.service');
  const { prisma } = await import('../src/lib/prisma');
  const rows = [{ id: 'a', question: 'Q a?' }, { id: 'b', question: 'Q b?' }, { id: 'c', question: 'Q c?' }];
  const stored: string[] = [];
  const orig = { q: prisma.$queryRaw, e: prisma.$executeRaw };
  (prisma.$queryRaw as any) = async () => rows;
  (prisma.$executeRaw as any) = async (q: { values: unknown[] }) => { stored.push(String(q.values[2])); return 1; };
  let call = 0;
  emb.setEmbeddingProvider({
    id: 'fake', model: 'scripted', dim: DIM,
    embed: async (texts) => { call++; if (call === 2) throw new Error('rate limited'); return texts.map(() => unit(1)); },
  });
  try {
    const result = await emb.backfillEmbeddings(2);
    assert.deepEqual(result, { embedded: 2, failed: 1 }, 'batch 1 (a, b) ok; batch 2 (c) failed');
    assert.deepEqual(stored, ['a', 'b']);
    emb.setEmbeddingProvider(null);
    assert.deepEqual(await emb.backfillEmbeddings(2), { embedded: 0, failed: 0 }, 'no provider: nothing to do');
  } finally {
    emb.resetEmbeddingProvider();
    (prisma.$queryRaw as any) = orig.q;
    (prisma.$executeRaw as any) = orig.e;
  }
});

test('the labelled pair set has at least 150 pairs across the required families', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pairs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'dedup-pairs.json'), 'utf8'));
  assert.ok(pairs.length >= 150, `${pairs.length} pairs`);
  const families = new Set(pairs.map((p: any) => p.family));
  for (const f of ['paraphrase', 'different-date', 'different-entity', 'boilerplate']) assert.ok(families.has(f), f);
  assert.ok(pairs.some((p: any) => p.duplicate) && pairs.some((p: any) => !p.duplicate));
});
