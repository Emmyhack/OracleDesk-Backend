import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

// Deterministic PRNG so every synthetic series is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

const GRID = 3600;
const T0 = 1_800_000_000 - (1_800_000_000 % GRID);
const TOTAL = 1_000_000_000n;
const TREASURY = 'CTREASURY';
const CFG = { minOverlap: 12, kappa: 20 };

/** A Trade event row whose reserves give the requested YES price (bps). */
function tradeRow(marketId: number, step: number, yesBps: number, i: number, trader = 'GEXTERNAL') {
  const reserveNo = (TOTAL * BigInt(yesBps)) / 10_000n;
  return {
    id: `${String(T0 + step * GRID).padStart(12, '0')}-${marketId}-${i}`,
    eventName: 'Trade',
    ledger: 1_000_000 + step * 100 + i,
    ledgerClosedAt: new Date((T0 + step * GRID - 60) * 1000),
    params: {
      market_id: String(marketId),
      trader,
      reserve_yes: (TOTAL - reserveNo).toString(),
      reserve_no: reserveNo.toString(),
    },
  };
}

function createdRow(marketId: number, yesBps: number) {
  return {
    id: `0-${marketId}-created`,
    eventName: 'MarketCreated',
    ledger: 1,
    ledgerClosedAt: new Date((T0 - 40 * GRID) * 1000),
    params: { market_id: String(marketId), initial_yes_bps: String(yesBps) },
  };
}

/** Logit random walk with one trade per grid step. */
function walk(rand: () => number, steps: number, start = 0): number[] {
  const xs = [start];
  for (let i = 1; i < steps; i++) xs.push(xs[i - 1] + 0.15 * gaussian(rand));
  return xs;
}

const toBps = (x: number) => Math.round(10_000 / (1 + Math.exp(-x)));

function rowsFor(marketId: number, xs: number[]) {
  return [createdRow(marketId, toBps(xs[0])), ...xs.map((x, k) => tradeRow(marketId, k, toBps(x), 0))];
}

/** Stubs prisma.$queryRaw: the loader's market id is its first interpolated value. */
async function stubRows(byMarket: Record<number, any[]>) {
  const { prisma } = await import('../src/lib/prisma');
  (prisma as any).$queryRaw = async (_strings: TemplateStringsArray, ...values: unknown[]) => byMarket[Number(values[0])] ?? [];
}

async function pairFor(rowsA: any[], rowsB: any[], catA = 'CRYPTO', catB = 'CRYPTO', steps = 80) {
  await stubRows({ 1: rowsA, 2: rowsB });
  const { estimateSnapshotPairs } = await import('../src/services/correlation.service');
  const now = new Date((T0 + steps * GRID) * 1000);
  const pairs = await estimateSnapshotPairs(
    [
      { id: 'a', category: catA, onChainMarketId: 1n },
      { id: 'b', category: catB, onChainMarketId: 2n },
    ],
    now,
    { ...CFG, gridSecs: GRID, windowDays: 14 },
  );
  assert.equal(pairs.length, 1);
  return pairs[0];
}

test('resample carries forward, is null before the first trade and after resolution', async () => {
  const { resample, seriesFromRows } = await import('../src/services/price-history.service');
  const points = seriesFromRows([
    tradeRow(1, 2, 4000, 0),
    tradeRow(1, 5, 6000, 0),
    { id: 'z', eventName: 'MarketResolved', ledger: 9_999_999, ledgerClosedAt: new Date((T0 + 8 * GRID - 60) * 1000), params: { market_id: '1', outcome: { tag: 'Yes' } } },
  ]);
  const grid = resample(points, T0, T0 + 10 * GRID, GRID);
  assert.deepEqual(grid, [null, null, 4000, 4000, 4000, 6000, 6000, 6000, null, null, null]);
});

test('several trades in one ledger collapse to the last one by event id', async () => {
  const { seriesFromRows } = await import('../src/services/price-history.service');
  const a = tradeRow(1, 3, 4000, 0);
  const b = { ...tradeRow(1, 3, 5500, 1), ledger: a.ledger, id: `${a.id}~later` };
  const points = seriesFromRows([b, a]);
  assert.equal(points.length, 1);
  assert.equal(points[0].yesBps, 5500);
});

test('prices come from reserves via BigInt, never Number', async () => {
  const { seriesFromRows } = await import('../src/services/price-history.service');
  const { priceYesBps } = await import('../src/generated/fpmm');
  const row = {
    ...tradeRow(1, 1, 5000, 0),
    params: { market_id: '1', trader: 'G', reserve_yes: '12345678901234567890', reserve_no: '98765432109876543210' },
  };
  const [p] = seriesFromRows([row]);
  assert.equal(p.yesBps, Number(priceYesBps(12345678901234567890n, 98765432109876543210n)));
});

test('perfectly co-moving series give rho near 1 once shrunk toward the prior', async () => {
  const xs = walk(mulberry32(1), 80);
  const est = await pairFor(rowsFor(1, xs), rowsFor(2, xs));
  assert.equal(est.method, 'empirical');
  assert.ok(est.sample! > 0.99, `sample ${est.sample}`);
  assert.ok(est.rho > 0.9, `rho ${est.rho}`);
  assert.ok(Math.abs(est.delta - 20 / (20 + est.n)) < 1e-12, 'δ = κ / (κ + n)');
});

test('independent random walks lean on the prior for small n and approach 0 for large n', async () => {
  // Small n: 14 trading steps → n = 13 returns, δ = 20/33.
  const smallA = walk(mulberry32(11), 14);
  const smallB = walk(mulberry32(12), 14);
  const small = await pairFor(rowsFor(1, smallA), rowsFor(2, smallB), 'CRYPTO', 'CRYPTO', 14);
  assert.equal(small.method, 'empirical');
  assert.ok(small.n >= 12 && small.n < 20);
  assert.ok(Math.abs(small.rho - small.prior * small.delta) < 0.4 * (1 - small.delta) + 0.05, `rho ${small.rho}`);
  assert.ok(small.rho > 0.2, 'the prior (0.70) still pulls the estimate up');

  const bigA = walk(mulberry32(21), 300);
  const bigB = walk(mulberry32(22), 300);
  const big = await pairFor(rowsFor(1, bigA), rowsFor(2, bigB), 'CRYPTO', 'CRYPTO', 300);
  assert.ok(Math.abs(big.sample!) < 0.2);
  assert.ok(Math.abs(big.rho) < 0.1 * big.prior + 0.2, `rho ${big.rho}`);
});

test('anti-correlated series give a negative rho and a NEGATIVE relationship', async () => {
  const xs = walk(mulberry32(5), 80);
  const est = await pairFor(rowsFor(1, xs), rowsFor(2, xs.map((x) => -x)));
  assert.ok(est.sample! < -0.99);
  assert.ok(est.rho < -0.6, `rho ${est.rho}`);

  const { evaluateCorrelation } = await import('../src/services/correlation.service');
  const snapshot = {
    id: 's1',
    computedAt: new Date(),
    pairs: new Map([['a|b', { ...est }]]),
  };
  const result = evaluateCorrelation({
    proposed: { marketId: 'a', category: 'CRYPTO', direction: 'YES' },
    proposedSize: 100,
    bankroll: 10_000,
    positions: [{ marketId: 'b', category: 'CRYPTO', direction: 'NO', size: 100 }],
    snapshot,
  });
  assert.equal(result.correlatedPairs[0].relationship, 'NEGATIVE');
  assert.equal(result.correlatedPairs[0].method, 'empirical');
});

test('pairs below the minimum overlap use the prior', async () => {
  const xs = walk(mulberry32(7), 6);
  const est = await pairFor(rowsFor(1, xs), rowsFor(2, xs), 'FED', 'MACRO', 6);
  assert.equal(est.method, 'prior');
  assert.equal(est.rho, 0.75);
  assert.equal(est.sample, null);
  assert.equal(est.delta, 1);
});

test('zero-variance series fall back to the prior', async () => {
  const flatA = Array.from({ length: 40 }, () => 0);
  const est = await pairFor(rowsFor(1, flatA), rowsFor(2, walk(mulberry32(3), 40)), 'SPORTS', 'SPORTS', 40);
  assert.equal(est.method, 'prior');
  assert.equal(est.rho, 0.65);
});

test('treasury-originated trades do not count as activity', async () => {
  const { seriesFromRows, activeIntervals } = await import('../src/services/price-history.service');
  const points = seriesFromRows(
    [tradeRow(1, 1, 4000, 0, TREASURY), tradeRow(1, 2, 4500, 0), tradeRow(1, 3, 5000, 0, TREASURY)],
    TREASURY,
  );
  assert.deepEqual(points.map((p) => p.active), [false, true, false]);
  assert.deepEqual(activeIntervals(points, T0, T0 + 4 * GRID, GRID), [false, true, false, false]);

  // Two markets the agent traded in lockstep show no overlap, so the prior wins.
  const xs = walk(mulberry32(9), 60);
  const { estimatePair } = await import('../src/services/correlation.service');
  const { resample } = await import('../src/services/price-history.service');
  const mk = (id: string, marketId: number) => {
    const pts = seriesFromRows(rowsFor(marketId, xs).map((r) => (r.eventName === 'Trade' ? { ...r, params: { ...r.params, trader: TREASURY } } : r)), TREASURY);
    return { marketId: id, category: 'CRYPTO', levels: resample(pts, T0, T0 + 60 * GRID, GRID), active: activeIntervals(pts, T0, T0 + 60 * GRID, GRID) };
  };
  const est = estimatePair(mk('a', 1), mk('b', 2), CFG);
  assert.equal(est.n, 0);
  assert.equal(est.method, 'prior');
});

test('exposure is weighted by rho and handles the four direction/sign cases', async () => {
  const { evaluateCorrelation } = await import('../src/services/correlation.service');
  const snap = (rho: number) => ({
    id: 's',
    computedAt: new Date(),
    pairs: new Map([['a|b', { a: 'a', b: 'b', rho, n: 50, method: 'empirical' as const, sample: rho, prior: 0, delta: 0.1 }]]),
  });
  const run = (rho: number, mine: 'YES' | 'NO', theirs: 'YES' | 'NO', size = 100) =>
    evaluateCorrelation({
      proposed: { marketId: 'a', category: 'CRYPTO', direction: mine },
      proposedSize: 400,
      bankroll: 10_000,
      positions: [{ marketId: 'b', category: 'CRYPTO', direction: theirs, size }],
      snapshot: snap(rho),
    });

  // rho > 0, same side: risk, weighted by rho (0.8 × 100)
  assert.equal(run(0.8, 'YES', 'YES').totalCorrelatedExposure, 80);
  // rho > 0, opposite sides: hedge → net exposure floors at 0
  assert.equal(run(0.8, 'YES', 'NO').totalCorrelatedExposure, 0);
  // rho < 0, same side (YES+YES on complements): hedge
  assert.equal(run(-0.8, 'YES', 'YES').totalCorrelatedExposure, 0);
  // rho < 0, opposite sides: risk, |rho| × size
  assert.equal(run(-0.8, 'YES', 'NO').totalCorrelatedExposure, 80);

  // The cap is 5% of 10 000 = 500: weighted exposure 80 leaves 420 of the 400.
  assert.equal(run(0.8, 'YES', 'YES').adjustedPositionSize, 400);
  assert.equal(run(0.8, 'YES', 'YES', 600).adjustedPositionSize, 20, '0.8 × 600 = 480 leaves 20 of the 500 cap');
  // A hedge restores room: same-side exposure 480 offset by an opposite 300 hedge.
  const hedged = evaluateCorrelation({
    proposed: { marketId: 'a', category: 'CRYPTO', direction: 'YES' },
    proposedSize: 400,
    bankroll: 10_000,
    positions: [
      { marketId: 'b', category: 'CRYPTO', direction: 'YES', size: 600 },
      { marketId: 'c', category: 'CRYPTO', direction: 'NO', size: 300 },
    ],
    snapshot: { id: 's', computedAt: new Date(), pairs: new Map([...snap(0.8).pairs, ['a|c', { a: 'a', b: 'c', rho: 0.8, n: 50, method: 'empirical' as const, sample: 0.8, prior: 0, delta: 0.1 }]]) },
  });
  assert.equal(hedged.totalCorrelatedExposure, 240);

  // Below the threshold nothing counts, whatever the sign.
  assert.equal(run(0.5, 'YES', 'YES').correlatedPairs.length, 0);
  assert.equal(run(-0.5, 'YES', 'NO').correlatedPairs.length, 0);
});

test('without a snapshot the category matrix is used and recorded per pair', async () => {
  const { evaluateCorrelation } = await import('../src/services/correlation.service');
  const result = evaluateCorrelation({
    proposed: { marketId: 'a', category: 'FED', direction: 'YES' },
    proposedSize: 100,
    bankroll: 10_000,
    positions: [{ marketId: 'b', category: 'MACRO', direction: 'YES', size: 200 }],
    snapshot: null,
  });
  assert.equal(result.method, 'matrix');
  assert.equal(result.snapshotId, null);
  assert.equal(result.correlatedPairs[0].method, 'matrix');
  assert.equal(result.totalCorrelatedExposure, 150, 'FED↔MACRO 0.75 × 200');
});

test('PSD projection gives non-negative eigenvalues and a unit diagonal', async () => {
  const { nearestPsdCorrelation, jacobiEigen } = await import('../src/services/correlation.service');
  // Pairwise estimates that cannot be a correlation matrix: a~b, b~c, but a~c strongly negative.
  const raw = [
    [1, 0.9, -0.9],
    [0.9, 1, 0.9],
    [-0.9, 0.9, 1],
  ];
  assert.ok(jacobiEigen(raw).values.some((l) => l < -0.1), 'input is indefinite');
  const psd = nearestPsdCorrelation(raw);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(psd[i][i] - 1) < 1e-9);
  for (const l of jacobiEigen(psd).values) assert.ok(l > -1e-9, `eigenvalue ${l}`);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(psd[i][j] - psd[j][i]) < 1e-9);

  // A valid correlation matrix is left (almost) unchanged.
  const ok = [[1, 0.3], [0.3, 1]];
  const same = nearestPsdCorrelation(ok);
  assert.ok(Math.abs(same[0][1] - 0.3) < 1e-6);
});

test('a stale snapshot falls back to the matrix; a fresh one is used', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const svc = await import('../src/services/correlation.service');
  const now = new Date('2026-10-18T12:00:00Z');
  const row = (ageMs: number) => ({
    id: 'snap-1',
    computedAt: new Date(now.getTime() - ageMs),
    gridStepSecs: 3600,
    windowDays: 14,
    pairs: [{ a: 'a', b: 'b', rho: 0.9, n: 40, method: 'empirical', sample: 0.95, prior: 0.7, delta: 0.1 }],
  });

  let current = row(3 * 60 * 60 * 1000);
  (prisma.correlationSnapshot.findFirst as any) = async () => current;
  svc.resetSnapshotCache();
  assert.equal(await svc.loadLatestSnapshot(now), null, 'older than 2 hours');

  current = row(30 * 60 * 1000);
  svc.resetSnapshotCache();
  const fresh = await svc.loadLatestSnapshot(now);
  assert.equal(fresh?.id, 'snap-1');

  // Cached for five minutes, even if the table changes.
  current = row(3 * 60 * 60 * 1000);
  assert.equal((await svc.loadLatestSnapshot(new Date(now.getTime() + 4 * 60_000)))?.id, 'snap-1');
  assert.equal(await svc.loadLatestSnapshot(new Date(now.getTime() + 6 * 60_000)), null);
  svc.resetSnapshotCache();
});

test('checkCorrelation reads the snapshot per pair and reports the method', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const svc = await import('../src/services/correlation.service');
  (prisma.market.findUnique as any) = async () => ({ id: 'a', category: 'CRYPTO' });
  (prisma.position.findMany as any) = async () => [
    { size: 200, direction: 'YES', market: { id: 'b', category: 'CRYPTO' } },
    { size: 100, direction: 'YES', market: { id: 'c', category: 'SPORTS' } },
  ];
  const now = new Date();
  (prisma.correlationSnapshot.findFirst as any) = async () => ({
    id: 'snap-9',
    computedAt: now,
    pairs: [{ a: 'a', b: 'b', rho: 0.2, n: 60, method: 'empirical', sample: 0.2, prior: 0.7, delta: 0.1 }],
  });
  svc.resetSnapshotCache();

  const result = await svc.checkCorrelation('a', 100, 10_000, { direction: 'YES' });
  // The category matrix would call CRYPTO↔CRYPTO 0.70; the snapshot says 0.2, below the threshold.
  assert.equal(result.correlatedPairs.length, 0);
  assert.equal(result.totalCorrelatedExposure, 0);
  assert.equal(result.snapshotId, 'snap-9');
  assert.equal(result.method, 'snapshot');
  svc.resetSnapshotCache();
});
