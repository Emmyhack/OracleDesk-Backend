/**
 * Calibration of agent probabilities (#68): metrics, weighting, exclusions,
 * the shrinkage hook and the HTTP surface. Pure where possible; the SQL runs
 * against a real database in tests/integration/calibration.int.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
type Sample = import('../src/services/calibration.service').Sample;
type TraceRow = import('../src/services/calibration.service').TraceRow;

const T0 = Date.parse('2026-09-01T00:00:00Z');
const row = (over: Partial<TraceRow> & { minute: number }): TraceRow => ({
  marketId: 'm1', agentType: 'TRADER', decisionType: 'OPEN_POSITION', category: 'FED',
  p: 0.7, pm: 0.5, o: 1, promptVersion: null, model: null,
  resolvedAt: new Date(T0 + 100 * 60_000),
  ...over,
  createdAt: new Date(T0 + over.minute * 60_000),
});

// ─── metrics ─────────────────────────────────────────────────────────────────
test('brier and log loss match hand-computed values', async () => {
  const { brier, logLoss } = await import('../src/services/calibration.service');
  const s: Sample[] = [
    { p: 0.8, o: 1, w: 1 },   // (0.2)² = 0.04     ; -ln 0.8 = 0.22314355
    { p: 0.3, o: 0, w: 1 },   // (0.3)² = 0.09     ; -ln 0.7 = 0.35667494
    { p: 0.6, o: 0, w: 2 },   // (0.6)² = 0.36 ×2  ; -ln 0.4 = 0.91629073 ×2
  ];
  close(brier(s), (0.04 + 0.09 + 2 * 0.36) / 4);
  close(logLoss(s), (0.22314355131 + 0.35667494394 + 2 * 0.91629073187) / 4, 1e-8);
  assert.ok(Number.isNaN(brier([])));
});

test('log loss clips p at 0 and 1 and reports how many samples were clipped', async () => {
  const { logLoss, clippedCount } = await import('../src/services/calibration.service');
  const s: Sample[] = [{ p: 1, o: 0, w: 1 }, { p: 0, o: 1, w: 1 }, { p: 0.5, o: 1, w: 1 }];
  const loss = logLoss(s);
  assert.ok(Number.isFinite(loss));
  close(loss, (-Math.log(1e-4) * 2 - Math.log(0.5)) / 3, 1e-9);
  assert.equal(clippedCount(s), 2);
});

/** 100 samples at each of ten probabilities whose observed frequency equals p exactly. */
function calibrated(): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < 10; i++) {
    const p = (i + 0.5) / 10;
    const yes = Math.round(p * 100);
    for (let j = 0; j < 100; j++) out.push({ p, o: j < yes ? 1 : 0, w: 1 });
  }
  return out;
}

test('perfectly calibrated data has reliability ≈ 0 and buckets on the diagonal', async () => {
  const { murphy, reliability, brier } = await import('../src/services/calibration.service');
  const s = calibrated();
  const m = murphy(s);
  close(m.reliability, 0, 1e-12);
  assert.ok(m.resolution > 0.07);
  close(m.uncertainty, 0.25, 1e-12);
  close(brier(s), m.reliability - m.resolution + m.uncertainty, 1e-12);
  for (const b of reliability(s)) {
    close(b.observed!, b.meanPredicted!, 1e-12);
    assert.equal(b.count, 100);
    assert.ok(b.wilson95!.lower <= b.observed! && b.observed! <= b.wilson95!.upper);
  }
});

test('Wilson intervals use the effective sample size, not the raw count', async () => {
  const { reliability, effectiveN } = await import('../src/services/calibration.service');
  const { wilson } = await import('../src/lib/stats');
  // 20 samples in one bucket: ten with weight 1, ten with weight 0.1
  const s: Sample[] = [
    ...Array.from({ length: 10 }, (_, i): Sample => ({ p: 0.55, o: i < 6 ? 1 : 0, w: 1 })),
    ...Array.from({ length: 10 }, (): Sample => ({ p: 0.55, o: 1, w: 0.1 })),
  ];
  const nEff = effectiveN(s);
  assert.ok(nEff < 20 && nEff > 10, `nEff ${nEff}`);
  const bucket = reliability(s)[5];
  close(bucket.nEff, nEff);
  const w = 10 * 1 + 10 * 0.1;
  const observed = (6 * 1 + 10 * 0.1) / w;
  const expected = wilson(observed * nEff, nEff);
  close(bucket.wilson95!.lower, expected.lower);
  close(bucket.wilson95!.upper, expected.upper);
  const raw = wilson(observed * 20, 20);
  assert.ok(bucket.wilson95!.upper - bucket.wilson95!.lower > raw.upper - raw.lower, 'fewer effective samples, wider interval');
});

test('wilson matches known values', async () => {
  const { wilson } = await import('../src/lib/stats');
  const w = wilson(8, 10);
  close(w.lower, 0.4902, 1e-3);
  close(w.upper, 0.9433, 1e-3);
  assert.deepEqual(wilson(0, 0), { lower: 0, upper: 1 });
});

test('quantile buckets hold equal weight', async () => {
  const { reliability } = await import('../src/services/calibration.service');
  const s: Sample[] = Array.from({ length: 100 }, (_, i) => ({ p: 0.01 + i * 0.0001, o: i % 2 === 0 ? 1 : 0, w: 1 }));
  const buckets = reliability(s, 10, 'quantile');
  for (const b of buckets) close(b.count, 10, 1e-9);
});

test('overconfident data yields a shrinkage factor below 1, and underconfident data is capped at 1', async () => {
  const { fitShrinkage, applyShrinkage, brier } = await import('../src/services/calibration.service');
  // says 0.9 / 0.1, but is right only 70 % of the time
  const over: Sample[] = [];
  for (let i = 0; i < 100; i++) over.push({ p: 0.9, o: i < 70 ? 1 : 0, w: 1 }, { p: 0.1, o: i < 30 ? 1 : 0, w: 1 });
  const { k, n } = fitShrinkage(over);
  assert.equal(n, 200);
  assert.ok(k < 1 && k >= 0.3);
  close(k, 0.4 / 0.8, 1e-9); // Σ(p−.5)(o−.5)/Σ(p−.5)² = 0.4·0.2 / 0.16·... = 0.5
  const shrunk = over.map((s) => ({ ...s, p: applyShrinkage(s.p, k) }));
  assert.ok(brier(shrunk) < brier(over), 'shrinking improves the Brier score');

  const under: Sample[] = [];
  for (let i = 0; i < 100; i++) under.push({ p: 0.6, o: i < 90 ? 1 : 0, w: 1 }, { p: 0.4, o: i < 10 ? 1 : 0, w: 1 });
  assert.equal(fitShrinkage(under).k, 1, 'never amplifies');

  // a noisy forecaster is bounded below at 0.3
  const noise: Sample[] = [{ p: 0.95, o: 0, w: 1 }, { p: 0.05, o: 1, w: 1 }];
  assert.equal(fitShrinkage(noise).k, 0.3);
  assert.equal(fitShrinkage([{ p: 0.5, o: 1, w: 1 }]).k, 1, 'no information: unchanged');
});

// ─── weighting and exclusions ────────────────────────────────────────────────
test('time weighting gives each market total weight 1 and weights traces by how long they were current', async () => {
  const { buildSamples } = await import('../src/services/calibration.service');
  // m1: traces at t=0 (p .6), t=20 (p .8), resolved at t=100 → spans 20, 80
  // m2: one trace
  const rows = [
    row({ minute: 0, p: 0.6 }), row({ minute: 20, p: 0.8 }),
    row({ marketId: 'm2', minute: 5, p: 0.3, o: 0 }),
  ];
  const s = buildSamples(rows, 'time');
  const m1 = s.filter((x) => x.p === 0.6 || x.p === 0.8);
  close(m1.reduce((a, x) => a + x.w, 0), 1);
  close(s.find((x) => x.p === 0.6)!.w, 0.2);
  close(s.find((x) => x.p === 0.8)!.w, 0.8);
  close(s.find((x) => x.p === 0.3)!.w, 1);
  // a trader that traced 50 times still carries weight 1
  const many = Array.from({ length: 50 }, (_, i) => row({ marketId: 'm3', minute: i, p: 0.5 }));
  close(buildSamples(many).reduce((a, x) => a + x.w, 0), 1);
});

test("'last' and 'first' keep one trace per market", async () => {
  const { buildSamples } = await import('../src/services/calibration.service');
  const rows = [row({ minute: 0, p: 0.6 }), row({ minute: 20, p: 0.8 })];
  assert.deepEqual(buildSamples(rows, 'last').map((x) => [x.p, x.w]), [[0.8, 1]]);
  assert.deepEqual(buildSamples(rows, 'first').map((x) => [x.p, x.w]), [[0.6, 1]]);
});

test('traces at or after resolution are excluded, however they reach the weighting', async () => {
  const { buildSamples } = await import('../src/services/calibration.service');
  const rows = [row({ minute: 10, p: 0.6 }), row({ minute: 100, p: 0.99 }), row({ minute: 130, p: 0.99 })];
  const s = buildSamples(rows);
  assert.equal(s.length, 1);
  assert.equal(s[0].p, 0.6);
  close(s[0].w, 1);
});

test('the extraction query filters voids, post-resolution traces and legacy rows in SQL', async () => {
  const { extractRows } = await import('../src/services/calibration.service');
  let sql = '';
  let values: unknown[] = [];
  const db = { $queryRaw: async (q: { sql: string; values: unknown[] }) => { sql = q.sql; values = q.values; return []; } };
  await extractRows(db as any, new Date('2026-06-01T00:00:00Z'));
  assert.match(sql, /m\.status = 'RESOLVED'/);
  assert.match(sql, /m\."resolvedOutcome" IS NOT NULL/);
  assert.match(sql, /m\."onChainMarketId" IS NOT NULL/);
  assert.match(sql, /t\."createdAt" < m\."resolvedAt"/);
  assert.match(sql, /->'llm'->0/);
  assert.equal(values.length, 2, 'the window start is bound (twice), never interpolated');
  assert.deepEqual(values, ['2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z']);
});

test('MARKET_CREATION traces carry no baseline: their 0.5 is a placeholder', async () => {
  const { buildSamples, computeSliceMetrics } = await import('../src/services/calibration.service');
  const creation = [row({ minute: 1, decisionType: 'MARKET_CREATION', pm: 0.5 })];
  assert.equal(buildSamples(creation)[0].pm, undefined);
  const rows = Array.from({ length: 25 }, (_, i) => row({ marketId: `c${i}`, minute: 1, decisionType: 'MARKET_CREATION', pm: 0.5, o: i % 2 ? 1 : 0 }));
  assert.equal(computeSliceMetrics(rows, { minMarkets: 20 }).baseline, null);
});

// ─── slices ──────────────────────────────────────────────────────────────────
function market(i: number, over: Partial<TraceRow> = {}): TraceRow {
  return row({ marketId: `m${i}`, minute: 1, p: i % 2 ? 0.7 : 0.3, o: i % 2 ? 1 : 0, pm: 0.5, ...over });
}

test('slices below MIN_CALIBRATION_MARKETS return insufficientData instead of noisy numbers', async () => {
  const { computeSliceMetrics } = await import('../src/services/calibration.service');
  const few = computeSliceMetrics(Array.from({ length: 19 }, (_, i) => market(i)), { minMarkets: 20 });
  assert.deepEqual(few, { insufficientData: true, nMarkets: 19, nTraces: 19, nEff: 19 });
  const enough = computeSliceMetrics(Array.from({ length: 20 }, (_, i) => market(i)), { minMarkets: 20 });
  assert.equal(enough.insufficientData, false);
  assert.ok(enough.brier! < 0.25);
  assert.ok(enough.baseline!.brier === 0.25 && enough.baseline!.agentBrier < 0.25, 'skill versus the market is visible');
  assert.equal(enough.buckets!.length, 10);
  assert.equal(enough.nMarkets, 20);
  close(enough.nEff, 20);
});

test('sliceRows groups by agent, category, decision, prompt version and model', async () => {
  const { sliceRows } = await import('../src/services/calibration.service');
  const rows = [
    market(1, { agentType: 'TRADER', category: 'FED', promptVersion: 'hedge-conditions@1', model: 'claude-sonnet-4-6' }),
    market(2, { agentType: 'MARKET_MAKER', category: 'CRYPTO', decisionType: 'MARKET_CREATION' }),
  ];
  assert.deepEqual([...sliceRows(rows, 'agentType').keys()].sort(), ['MARKET_MAKER', 'TRADER']);
  assert.deepEqual([...sliceRows(rows, 'agentType_category').keys()].sort(), ['MARKET_MAKER:CRYPTO', 'TRADER:FED']);
  assert.deepEqual([...sliceRows(rows, 'promptVersion').keys()].sort(), ['hedge-conditions@1', 'unknown']);
  assert.deepEqual([...sliceRows(rows, 'model').keys()].sort(), ['claude-sonnet-4-6', 'unknown']);
  assert.deepEqual([...sliceRows(rows, 'decisionType').keys()].sort(), ['MARKET_CREATION', 'OPEN_POSITION']);
});

// ─── trader shrinkage ────────────────────────────────────────────────────────
test('shrinkage applies only when enabled and the fit rests on enough markets', async () => {
  const { calibrationShrinkage, MIN_SHRINKAGE_MARKETS } = await import('../src/services/calibration.service');
  const snap = (nMarkets: number, k: number, insufficientData = false) =>
    async () => ({ computedAt: new Date(), slices: [{ groupKey: 'x', metrics: { insufficientData, nMarkets, shrinkageK: k } }] });

  assert.equal(MIN_SHRINKAGE_MARKETS, 50);
  const off = await calibrationShrinkage('TRADER', 'FED', { enabled: false, lookup: snap(500, 0.5) as any });
  assert.deepEqual(off, { k: 1, source: 'none', nMarkets: 0 });
  const few = await calibrationShrinkage('TRADER', 'FED', { enabled: true, lookup: snap(49, 0.5) as any });
  assert.equal(few.k, 1);
  const thin = await calibrationShrinkage('TRADER', 'FED', { enabled: true, lookup: snap(80, 0.5, true) as any });
  assert.equal(thin.k, 1);
  const ok = await calibrationShrinkage('TRADER', 'FED', { enabled: true, lookup: snap(50, 0.62) as any });
  assert.deepEqual(ok, { k: 0.62, source: 'agentType_category', nMarkets: 50 });
  const clamped = await calibrationShrinkage('TRADER', 'FED', { enabled: true, lookup: snap(90, 0.01) as any });
  assert.equal(clamped.k, 0.3);

  // falls back from (agentType, category) to (agentType), then to 1
  const calls: string[] = [];
  const fallback = await calibrationShrinkage('TRADER', 'FED', {
    enabled: true,
    lookup: (async (q: any) => {
      calls.push(`${q.groupBy}:${q.groupKey}`);
      return q.groupBy === 'agentType'
        ? { computedAt: new Date(), slices: [{ groupKey: 'TRADER', metrics: { insufficientData: false, nMarkets: 120, shrinkageK: 0.8 } }] }
        : { computedAt: null, slices: [] };
    }) as any,
  });
  assert.deepEqual(calls, ['agentType_category:TRADER:FED', 'agentType:TRADER']);
  assert.deepEqual(fallback, { k: 0.8, source: 'agentType', nMarkets: 120 });
});

// ─── HTTP ────────────────────────────────────────────────────────────────────
async function withServer(fn: (base: string) => Promise<void>) {
  const { default: app } = await import('../src/app');
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('GET /api/v1/agents/calibration validates the query and returns the latest snapshot', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const computedAt = new Date('2026-10-18T03:10:00Z');
  const asked: any[] = [];
  const origFirst = prisma.calibrationSnapshot.findFirst;
  const origMany = prisma.calibrationSnapshot.findMany;
  (prisma.calibrationSnapshot.findFirst as any) = async (a: any) => { asked.push(a.where); return { computedAt }; };
  (prisma.calibrationSnapshot.findMany as any) = async (a: any) => {
    asked.push(a.where);
    return [
      { groupKey: 'TRADER:FED', metrics: { insufficientData: false, nMarkets: 60, brier: 0.2 } },
      { groupKey: 'TRADER:CRYPTO', metrics: { insufficientData: true, nMarkets: 4, nTraces: 9, nEff: 4 } },
      { groupKey: 'MARKET_MAKER:FED', metrics: { insufficientData: true, nMarkets: 1, nTraces: 1, nEff: 1 } },
    ];
  };
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/v1/agents/calibration?window=30d&groupBy=agentType_category&agentType=TRADER`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') ?? '', /max-age=300/);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.window, '30d');
      assert.equal(body.data.computedAt, computedAt.toISOString());
      assert.deepEqual(body.data.slices.map((s: any) => s.groupKey), ['TRADER:FED', 'TRADER:CRYPTO']);
      assert.equal(body.data.slices[1].insufficientData, true);
      assert.equal(body.data.slices[0].brier, 0.2);
      assert.deepEqual(asked[0], { window: '30d', groupBy: 'agentType_category' });
      assert.deepEqual(asked[1], { window: '30d', groupBy: 'agentType_category', computedAt });

      // defaults
      assert.equal((await fetch(`${base}/api/v1/agents/calibration`)).status, 200);
      assert.deepEqual(asked[asked.length - 2], { window: '90d', groupBy: 'agentType' });

      for (const bad of ['window=7d', 'groupBy=nope', 'agentType=ROBOT', 'category=WEATHER', 'groupBy=decisionType&agentType=TRADER']) {
        const r = await fetch(`${base}/api/v1/agents/calibration?${bad}`);
        assert.equal(r.status, 400, bad);
        assert.equal((await r.json()).error.code, 'VALIDATION_ERROR');
      }
    });
  } finally {
    (prisma.calibrationSnapshot.findFirst as any) = origFirst;
    (prisma.calibrationSnapshot.findMany as any) = origMany;
  }
});

test('with no snapshot yet the endpoint returns an empty list, not an error', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const orig = prisma.calibrationSnapshot.findFirst;
  (prisma.calibrationSnapshot.findFirst as any) = async () => null;
  try {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/v1/agents/calibration`)).json();
      assert.deepEqual([body.data.computedAt, body.data.slices], [null, []]);
    });
  } finally {
    (prisma.calibrationSnapshot.findFirst as any) = orig;
  }
});

test('POST /api/v1/agents/calibration/recompute is admin-only', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  const token = signToken('00000000-0000-4000-8000-000000000001', 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H');
  await withServer(async (base) => {
    const anon = await fetch(`${base}/api/v1/agents/calibration/recompute`, { method: 'POST' });
    assert.equal(anon.status, 401);
    const nonAdmin = await fetch(`${base}/api/v1/agents/calibration/recompute`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(nonAdmin.status, 403);
  });
});
