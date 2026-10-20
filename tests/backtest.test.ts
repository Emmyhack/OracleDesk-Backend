import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const FIXTURES = join(__dirname, '..', '..', 'tests', 'fixtures', 'backtest');

// ─── Characterization: runTraderCycle's database and chain calls ──────────────
//
// Records every Prisma and chain call runTraderCycle() makes against a fixed
// stub database (LLM and IPFS steps stubbed out), and asserts the sequence
// matches tests/fixtures/backtest/trader-cycle-calls.json. The fixture was
// recorded from the pre-refactor implementation, so moving the decisions into
// TraderPolicy must leave production behaviour unchanged. Re-record only for a
// deliberate behaviour change: UPDATE_FIXTURES=1 npm test.

function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
      .replace(/"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g, '"<iso>"'),
  );
}

async function recordTraderCycle(closedTodayPnl = -5): Promise<unknown[]> {
  const calls: unknown[] = [];
  const rec = <T>(name: string, result: (args: any) => T) => async (args?: any) => {
    calls.push({ call: name, args: normalize(args) });
    return result(args);
  };

  const { prisma } = await import('../src/lib/prisma');
  const p: any = prisma;

  const position = (over: Record<string, unknown>) => ({
    id: 'p-open', marketId: 'm-held', tradeId: 't-1', direction: 'YES', status: 'OPEN',
    entryPrice: 0.5, currentPrice: 0.5, size: 100, pnl: 0, ...over,
  });
  const positions = [
    position({ id: 'p-stop', marketId: 'm-stop', currentPrice: 0.3, entryPrice: 0.5, pnl: -20 }),
    position({ id: 'p-hold', marketId: 'm-held', currentPrice: 0.52, entryPrice: 0.5, pnl: 2 }),
  ];
  const markets: Record<string, any> = {
    'm-new': { id: 'm-new', question: 'Will BTC close above 100k?', category: 'CRYPTO', status: 'ACTIVE', currentYesProb: 0.4, initialYesProb: 0.4, totalLiquidity: 900, onChainMarketId: 7n },
    'm-held': { id: 'm-held', question: 'Will ETH close above 5k?', category: 'CRYPTO', status: 'ACTIVE', currentYesProb: 0.52, initialYesProb: 0.5, totalLiquidity: 900, onChainMarketId: 8n },
    'm-hedge': { id: 'm-hedge', category: 'CRYPTO', status: 'ACTIVE', currentYesProb: 0.5, initialYesProb: 0.5, totalLiquidity: 2000, onChainMarketId: 9n },
  };

  p.position.findMany = rec('position.findMany', (a) => {
    if (a?.where?.status?.in) return [{ pnl: closedTodayPnl }]; // closed today
    if (a?.where?.sharesRaw) return [];                          // mark-to-market: no share-denominated positions here
    if (a?.include?.trade) {                                    // hedge scan
      return [{ ...positions[0], market: { id: 'm-stop', category: 'CRYPTO', currentYesProb: 0.3, totalLiquidity: 900 }, trade: { edgeDetected: 0.2 } }];
    }
    if (a?.include?.market) return [{ ...positions[1], market: { id: 'm-held', category: 'CRYPTO' } }]; // correlation
    return positions;
  });
  p.position.findUnique = rec('position.findUnique', (a) => positions.find((x) => x.id === a.where.id) ?? null);
  p.position.findFirst = rec('position.findFirst', (a) => (a.where.marketId === 'm-held' ? positions[1] : null));
  p.position.update = rec('position.update', (a) => ({ ...positions[0], ...a.data }));
  p.position.create = rec('position.create', (a) => ({ id: 'p-new', ...a.data }));
  p.market.findMany = rec('market.findMany', () => [markets['m-new'], markets['m-held']]);
  p.market.findUnique = rec('market.findUnique', (a) => markets[a.where.id] ?? null);
  p.market.findFirst = rec('market.findFirst', () => markets['m-hedge']);
  p.trade.create = rec('trade.create', (a) => ({ id: `t-${calls.length}`, ...a.data }));
  p.trade.update = rec('trade.update', (a) => ({ id: a.where.id, ...a.data }));
  // #35: executeTrade applies the confirmed buy through guarded updates and
  // reads the result back instead of writing success state inline.
  const tradeRows = new Map<string, any>();
  p.trade.findUnique = rec('trade.findUnique', (a) => tradeRows.get(a.where.id) ?? null);
  p.trade.updateMany = rec('trade.updateMany', (a) => {
    const row = tradeRows.get(a.where.id) ?? { id: a.where.id, marketId: 'm-new', direction: 'YES', amount: 25, status: 'PENDING' };
    if (a.where.status?.in && !a.where.status.in.includes(row.status)) return { count: 0 };
    tradeRows.set(a.where.id, Object.assign(row, a.data));
    return { count: 1 };
  });
  const origTradeCreate = p.trade.create;
  p.trade.create = async (a: any) => {
    const row = await origTradeCreate(a);
    tradeRows.set(row.id, { ...row, status: row.status ?? 'PENDING' });
    return row;
  };
  const createdPositions = new Map<string, any>();
  const origPositionCreate = p.position.create;
  p.position.create = async (a: any) => {
    const row = await origPositionCreate(a);
    if (a?.data?.tradeId) createdPositions.set(a.data.tradeId, row);
    return row;
  };
  const origPositionFindUnique = p.position.findUnique;
  p.position.findUnique = (a: any) =>
    a?.where?.tradeId !== undefined
      ? rec('position.findUnique', () => createdPositions.get(a.where.tradeId) ?? null)(a)
      : origPositionFindUnique(a);
  p.agentLog.create = rec('agentLog.create', (a) => a.data);
  p.correlationSnapshot.findFirst = rec('correlationSnapshot.findFirst', () => null);
  p.$transaction = async (ops: Promise<unknown>[]) => {
    calls.push({ call: '$transaction', ops: ops.length });
    return Promise.all(ops);
  };

  const ingestion = await import('../src/services/ingestion.service');
  const marketSvc = await import('../src/services/market.service');
  const reasoning = await import('../src/services/reasoning.service');
  const chain = await import('../src/services/chain.service');
  const publish = await import('../src/services/trace-publish.service');
  const correlation = await import('../src/services/correlation.service');
  correlation.resetSnapshotCache();

  (ingestion as any).aggregateSignals = async () => {
    calls.push({ call: 'aggregateSignals' });
    return {
      news: [1, 2, 3, 4].map((i) => ({ source: 'NEWSAPI', title: `headline ${i}`, content: '', publishedAt: '', relevanceScore: 0.6, category: 'CRYPTO' })),
      fed: [], macro: [], aggregatedAt: new Date(), signalCount: 4,
    };
  };
  // The forecast (#75) is stubbed so the cycle reaches sizing, correlation and execution.
  void marketSvc;
  const forecastSvc = await import('../src/services/forecast.service');
  (forecastSvc as any).rankForForecast = async (markets: unknown[]) => markets;
  (forecastSvc as any).forecastMarket = async (market: { id: string }) => {
    calls.push({ call: 'forecastMarket', marketId: market.id });
    return { forecast: { p: 0.7, ci: { lower: 0.62, upper: 0.78 }, members: [], inputsDigest: 'd', sigmaLogit: 0, shrink: 0 }, relevant: [], cached: false };
  };
  // Treasury capital and caps (#76): the same 10 000 USDC the old constant
  // assumed, with caps that do not bind.
  (chain as any).treasuryAvailableCapital = async () => { calls.push({ call: 'chain.treasuryAvailableCapital' }); return 100_000_000_000n; };
  (chain as any).treasuryRiskConfig = async () => { calls.push({ call: 'chain.treasuryRiskConfig' }); return { max_trade: 10n ** 15n, max_market: 10n ** 15n, max_daily: 10n ** 15n }; };
  (chain as any).treasuryDailyUsage = async () => { calls.push({ call: 'chain.treasuryDailyUsage' }); return { amount: 0n, day_start: 0n }; };
  p.chainEvent.findFirst = rec('chainEvent.findFirst', () => null);
  p.trade.findMany = rec('trade.findMany', () => []);
  (reasoning as any).generateReasoningTrace = async (input: any) => {
    calls.push({ call: 'generateReasoningTrace', input: normalize(input) });
    return { trace: { id: 'trace-1' }, tracePayload: { traceId: 'trace-1' } };
  };
  (chain as any).quoteBuy = async (...a: unknown[]) => { calls.push({ call: 'chain.quoteBuy', args: normalize(a) }); return 1_000_000n; };
  // agentBuy takes a thunk so each attempt re-quotes min_shares_out (#40).
  (chain as any).agentBuy = async (thunk: unknown) => {
    const a = typeof thunk === 'function' ? await thunk() : thunk;
    calls.push({ call: 'chain.agentBuy', args: normalize(a) });
    return { mode: 'live', method: 'agent_buy', value: 1n, txHash: 'ab'.repeat(32) };
  };
  (publish as any).enqueueTracePublication = async (a: unknown) => { calls.push({ call: 'enqueueTracePublication', args: normalize(a) }); };

  // Agent controls (#79): the gate is open, and a drawdown pause is only recorded.
  const controls = await import('../src/services/agent-controls.service');
  (controls as any).gateCycle = async () => 1;
  (controls as any).pauseAgent = async (scope: string, p: { source: string; until?: Date }) => {
    calls.push({ call: 'pauseAgent', scope, source: p.source });
  };
  // executeTrade reads fee_bps from get_market to record the fee paid (#78).
  (chain as any).getOnChainMarket = async (...a: unknown[]) => { calls.push({ call: 'chain.getOnChainMarket', args: normalize(a) }); return { fee_bps: 100 }; };
  // Exits go on-chain (#77); the characterization only records that the stop-loss reaches exitPosition.
  const exits = await import('../src/services/exit.service');
  (exits as any).exitPosition = async (id: string, opts: { reason: string }) => {
    calls.push({ call: 'exitPosition', id, reason: opts.reason });
    return { status: 'CONFIRMED', exitId: 'x', sharesSoldRaw: 0n, collateralOutRaw: 0n, closed: true };
  };

  const { runTraderCycle } = await import('../src/agents/trader.agent');
  await runTraderCycle({ signal: new AbortController().signal });
  return calls;
}

function checkRecorded(name: string, calls: unknown[]) {
  const file = join(FIXTURES, 'trader-cycle-calls.json');
  const all = JSON.parse(readFileSync(file, 'utf8'));
  if (process.env.UPDATE_FIXTURES === '1') {
    all[name] = calls;
    writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
  }
  assert.deepEqual(calls, all[name]);
}

test('characterization: runTraderCycle makes the recorded sequence of calls', async () => {
  checkRecorded('cycle', await recordTraderCycle());
});

test('characterization: a drawdown pause stops the cycle after the daily-loss query', async () => {
  checkRecorded('paused', await recordTraderCycle(-400));
});

// ─── Simulation core ──────────────────────────────────────────────────────────

const USDC = 10_000_000n;
const ROOT = join(__dirname, '..', '..');

test('SimPool.agentBuy matches calcBuy and moves the price as on-chain', async () => {
  const { SimPool } = await import('../src/backtest/sim-pool');
  const { calcBuy, priceYesBps, seedReserves } = await import('../src/generated/fpmm');
  const seed = seedReserves(1000n * USDC, 4000n);
  const pool = new SimPool(seed.reserveYes, seed.reserveNo, 100n, 2_000_000_000);
  const before = pool.priceYesBps();
  assert.ok(Math.abs(before - 4000) <= 1, 'floor rounding');

  const expected = calcBuy(seed.reserveYes, seed.reserveNo, 100n * USDC, 100n);
  const fill = pool.agentBuy('Yes', 100n * USDC, 1_000);
  assert.equal(fill.sharesOut, expected.sharesOut);
  assert.equal(fill.fee, expected.fee);
  assert.equal(pool.reserveYes, expected.newReserveBought);
  assert.equal(pool.reserveNo, expected.newReserveOther);
  assert.equal(pool.priceYesBps(), Number(priceYesBps(expected.newReserveBought, expected.newReserveOther)));
  assert.ok(pool.priceYesBps() > before, 'buying YES raises the YES price');

  const no = pool.agentBuy('No', 100n * USDC, 1_000);
  assert.ok(no.sharesOut > 0n);

  // A round trip never makes money: selling what was bought returns less than was paid.
  const fresh = new SimPool(seed.reserveYes, seed.reserveNo, 100n, 2_000_000_000);
  const bought = fresh.agentBuy('Yes', 50n * USDC, 1_000);
  const sold = fresh.agentSell('Yes', bought.sharesOut, 1_000);
  assert.ok(sold.collateralOut < 50n * USDC);
  assert.ok(sold.sharesSold <= bought.sharesOut);
});

test('SimPool refuses trades at and after close_time, and once the market is resolved', async () => {
  const { SimPool, SimError } = await import('../src/backtest/sim-pool');
  const pool = SimPool.seeded(500n * USDC, 5000, 100, 10_000);
  assert.ok(pool.agentBuy('Yes', USDC, 9_999).sharesOut > 0n);
  assert.throws(() => pool.agentBuy('Yes', USDC, 10_000), (e: any) => e instanceof SimError && e.code === 'MarketClosed');
  assert.throws(() => pool.agentBuy('No', USDC, 99_999), (e: any) => e.code === 'MarketClosed');

  const resolved = SimPool.seeded(500n * USDC, 5000, 100, 10_000);
  resolved.resolve('Yes');
  assert.throws(() => resolved.agentBuy('Yes', USDC, 1), (e: any) => e.code === 'MarketNotOpen');
});

test('SimTreasury rejects MaxTrade, MaxMarket and Daily exactly at the cap boundaries', async () => {
  const { SimTreasury } = await import('../src/backtest/sim-treasury');
  const t = new SimTreasury({ cash: 10_000n * USDC, maxTrade: 100n * USDC, maxMarket: 150n * USDC, maxDaily: 220n * USDC });

  assert.equal(t.reserve('a', 100n * USDC + 1n, 0), 'TradeCapExceeded');
  assert.equal(t.reserve('a', 100n * USDC, 1_000), null, 'exactly max_trade is allowed');
  assert.equal(t.reserve('a', 50n * USDC + 1n, 1_000), 'MarketCapExceeded');
  assert.equal(t.reserve('a', 50n * USDC, 1_000), null, 'exactly max_market is allowed');
  assert.equal(t.reserve('a', 1n, 1_000), 'MarketCapExceeded');

  // Daily: 150 spent; 70 more fits exactly, 71 does not.
  assert.equal(t.reserve('b', 70n * USDC + 1n, 1_000), 'DailyCapExceeded');
  assert.equal(t.reserve('b', 70n * USDC, 1_000), null);
  assert.equal(t.reserve('b', 1n, 1_000), 'DailyCapExceeded');
  assert.equal(t.cash, (10_000n - 220n) * USDC);

  // The window rolls 24 h after its first spend, and a new one starts at the next spend.
  assert.equal(t.reserve('c', 1n, 1_000 + 86_399), 'DailyCapExceeded');
  assert.equal(t.reserve('c', 100n * USDC, 1_000 + 86_400), null);
  assert.equal(t.dailyUsage.dayStart, 1_000 + 86_400);

  assert.equal(t.reserve('d', 0n, 0), 'InvalidAmount');
  const poor = new SimTreasury({ cash: 10n, maxTrade: 100n, maxMarket: 100n, maxDaily: 100n });
  assert.equal(poor.reserve('a', 11n, 0), 'InsufficientBalance');
  poor.credit(5n);
  assert.equal(poor.reserve('a', 15n, 0), null, 'sell proceeds are credited without caps');
});

// ─── Replay ───────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 9, 1);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

async function baseConfig(over: Record<string, unknown> = {}) {
  const { DEFAULT_PARAMS } = await import('../src/agents/trader-policy');
  return {
    from: iso(T0), to: iso(T0 + 7 * DAY), stepMinutes: 15,
    bankrollRaw: 10_000n * USDC, maxTradeRaw: 500n * USDC, maxMarketRaw: 5_000n * USDC, maxDailyRaw: 5_000n * USDC,
    forecaster: 'prior', seed: 1, params: DEFAULT_PARAMS,
    ...over,
  } as any;
}

async function fixtureInputs() {
  return JSON.parse(readFileSync(join(FIXTURES, 'events.json'), 'utf8'));
}

test('the fixture is regenerated by tests/helpers/backtest-fixture.ts and follows calcBuy', async () => {
  const { buildFixture } = await import('./helpers/backtest-fixture');
  const { calcBuy } = await import('../src/generated/fpmm');
  const built = buildFixture();
  const file = join(FIXTURES, 'events.json');
  if (process.env.UPDATE_FIXTURES === '1') writeFileSync(file, JSON.stringify(built, null, 2) + '\n');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), JSON.parse(JSON.stringify(built)));

  // Each trade's reserves follow from the previous pool by calcBuy.
  const pools = new Map<string, { yes: bigint; no: bigint }>();
  for (const e of built.events) {
    const p = e.params;
    if (e.eventName === 'Trade') {
      const pool = pools.get(p.market_id)!;
      const q = p.outcome.tag === 'Yes' ? calcBuy(pool.yes, pool.no, BigInt(p.collateral), 100n) : calcBuy(pool.no, pool.yes, BigInt(p.collateral), 100n);
      assert.equal(q.sharesOut.toString(), p.shares);
      assert.equal(p.outcome.tag === 'Yes' ? q.newReserveBought.toString() : q.newReserveOther.toString(), p.reserve_yes);
      pools.set(p.market_id, { yes: BigInt(p.reserve_yes), no: BigInt(p.reserve_no) });
    } else if (e.eventName === 'MarketCreated') {
      const { seedReserves } = await import('../src/generated/fpmm');
      const r = seedReserves(BigInt(p.seed_amount), BigInt(p.initial_yes_bps));
      pools.set(p.market_id, { yes: r.reserveYes, no: r.reserveNo });
    }
  }
});

test('the prior and oracle-noise σ=0 forecasters are profitable on the synthetic two-market history', async () => {
  const { runBacktest } = await import('../src/backtest/engine');
  const inputs = await fixtureInputs();

  for (const forecaster of ['prior', 'oracle-noise:0']) {
    const report = await runBacktest(inputs, await baseConfig({ forecaster }));
    for (const impact of ['reset', 'propagate'] as const) {
      const run = report.runs[impact]!;
      assert.ok(BigInt(run.summary.pnlRaw) > 0n, `${forecaster}/${impact} pnl ${run.summary.pnlRaw}`);
      assert.ok(run.perMarket.every((m) => BigInt(m.pnlRaw) > 0n));
      if (forecaster === 'prior') {
        // The prior waits for the burst, then holds one position per market to resolution.
        assert.equal(run.summary.buys, 2, `${impact}: one position per market`);
        assert.equal(run.summary.closedPositions, 2);
        assert.equal(run.summary.winRate, 1);
        assert.equal(run.summary.stopLossCount, 0);
      } else {
        // The oracle knows the answer at the first step, so the burst stops it out once before it re-enters.
        assert.ok(run.summary.stopLossCount > 0);
      }
      assert.ok(BigInt(run.summary.impactCostRaw) > 0n, 'filling moves the price against the agent');
    }
  }
});

test('same inputs and seed produce a byte-identical report.json, with config and inputs hashes', async () => {
  const { runBacktest } = await import('../src/backtest/engine');
  const { reportJson, renderMarkdown } = await import('../src/backtest/report');
  const inputs = await fixtureInputs();
  const cfg = await baseConfig({ forecaster: 'oracle-noise:0.2', seed: 7 });

  const a = await runBacktest(inputs, cfg);
  const b = await runBacktest(JSON.parse(JSON.stringify(inputs)), { ...cfg });
  assert.equal(reportJson(a), reportJson(b));
  assert.equal(renderMarkdown(a), renderMarkdown(b));
  assert.match(a.configHash, /^[0-9a-f]{64}$/);
  assert.match(a.inputsHash, /^[0-9a-f]{64}$/);

  // The hashes move with the inputs and the config; the noise moves with the seed.
  const reseeded = await runBacktest(inputs, { ...cfg, seed: 8 });
  assert.notEqual(reseeded.configHash, a.configHash);
  assert.equal(reseeded.inputsHash, a.inputsHash);
  const fewer = await runBacktest({ ...inputs, events: inputs.events.slice(0, -1) }, cfg);
  assert.notEqual(fewer.inputsHash, a.inputsHash);
  // Event order in the input file does not matter.
  const shuffled = await runBacktest({ ...inputs, events: [...inputs.events].reverse() }, cfg);
  assert.equal(shuffled.inputsHash, a.inputsHash);
  assert.equal(reportJson(shuffled), reportJson(a));
});

test('the policy never sees an event with ledgerClosedAt after the simulated clock', async () => {
  const { runBacktest } = await import('../src/backtest/engine');
  const { History } = await import('./helpers/backtest-fixture');
  // A huge trade at +3 h pushes YES to ~90%; the replay stops at +2.5 h.
  const h = new History()
    .create(1, T0, { seedUsdc: 500n, yesBps: 5000, category: 'Crypto', closeMs: T0 + 2 * DAY })
    .buy(1, T0 + 60 * MIN, 'Yes', 20n);
  const before = h.price(1);
  h.buy(1, T0 + 180 * MIN, 'Yes', 5_000n).resolve(1, T0 + 240 * MIN, 'Yes');
  assert.ok(h.price(1) > 8500);

  const prices: number[] = [];
  const reads: Array<{ now: number; latest: number | null }> = [];
  const policy = async (env: any) => {
    for (const m of await env.candidateMarkets(env.clock.now(), { minLiquidity: 0, horizonDays: 30 })) prices.push(m.currentYesProb);
  };
  const report = await runBacktest(
    { events: h.events, signals: [], forecasts: [] },
    await baseConfig({ from: iso(T0 + 30 * MIN), to: iso(T0 + 150 * MIN) }),
    {
      impacts: ['reset', 'propagate'],
      policy,
      observe: ({ now, latestEventAt }) => reads.push({ now: now.getTime(), latest: latestEventAt?.getTime() ?? null }),
    },
  );

  assert.ok(reads.length > 0, 'the instrumented env was read');
  for (const r of reads) assert.ok(r.latest === null || r.latest <= r.now, `saw an event from the future at ${new Date(r.now).toISOString()}`);
  assert.ok(prices.length > 0);
  for (const p of prices) assert.ok(p < 0.7, `price ${p} reflects the +3 h trade`);
  assert.ok(Math.abs(prices[prices.length - 1] - before / 10_000) < 0.01);
  assert.equal(report.runs.reset!.summary.closedPositions, 0, 'the +4 h resolution is not replayed');
});

test('signals and recorded forecasts are filtered by fetchedAt/at ≤ now', async () => {
  const { runBacktest } = await import('../src/backtest/engine');
  const { History } = await import('./helpers/backtest-fixture');
  const h = new History().create(1, T0, { seedUsdc: 500n, yesBps: 5000, category: 'Crypto', closeMs: T0 + 2 * DAY });
  const seen: Array<{ news: number; forecast: number | null }> = [];
  const policy = async (env: any) => {
    const signals = await env.signals(env.clock.now());
    const [m] = await env.candidateMarkets(env.clock.now(), { minLiquidity: 0, horizonDays: 30 });
    const f = await env.forecast(m, signals);
    seen.push({ news: signals.news.length, forecast: f ? f.p : null });
  };
  await runBacktest(
    {
      events: h.events,
      signals: [{ source: 'NEWSAPI', fetchedAt: iso(T0 + 45 * MIN), payload: [{ source: 'NEWSAPI', title: 'x' }] }],
      forecasts: [{ marketId: '1', at: iso(T0 + 45 * MIN), p: 0.7 }],
    },
    await baseConfig({ from: iso(T0 + 30 * MIN), to: iso(T0 + 60 * MIN), forecaster: 'recorded' }),
    { impacts: ['reset'], policy },
  );
  assert.deepEqual(seen.map((s) => s.news), [0, 1, 1], 'ticks at +30, +45 and +60 min; the signal was fetched at +45');
  assert.deepEqual(seen.map((s) => s.forecast), [null, 0.7, 0.7]);
});

test('a voided market settles at half value per share', async () => {
  const { runBacktest } = await import('../src/backtest/engine');
  const { History } = await import('./helpers/backtest-fixture');
  const h = new History()
    .create(1, T0, { seedUsdc: 500n, yesBps: 5000, category: 'Crypto', closeMs: T0 + 3 * DAY })
    .resolve(1, T0 + 2 * DAY, null);

  let bought = false;
  const policy = async (env: any) => {
    if (bought) return;
    bought = true;
    const [m] = await env.candidateMarkets(env.clock.now(), { minLiquidity: 0, horizonDays: 30 });
    await env.buy({ marketId: m.id, direction: 'YES', amount: 100, price: 0.5, marketProb: 0.5, edge: 0.2, kelly: 0.01, forecast: { p: 0.7, ci: { lower: 0.6, upper: 0.8 }, sources: [] }, correlation: {} });
  };
  const report = await runBacktest({ events: h.events, signals: [], forecasts: [] }, await baseConfig({ from: iso(T0 + 15 * MIN), to: iso(T0 + 3 * DAY) }), { impacts: ['reset'], policy });
  const run = report.runs.reset!;
  const trade = run.trades[0];
  const closed = run.closed[0];
  assert.equal(closed.closeReason, 'VOIDED');
  assert.equal(BigInt(closed.payoutRaw), BigInt(trade.sharesRaw) / 2n, 'settleValue("void") is (yes + no) / 2 per share');
  assert.ok(BigInt(closed.pnlRaw) < 0n, 'bought above 50%, voided at 50%');
});

test('propagating the agent\'s impact earns less than resetting it when it buys repeatedly', async () => {
  const { runBacktest } = await import('../src/backtest/engine');
  const { History } = await import('./helpers/backtest-fixture');
  // A small external YES buy lands one minute before each 15-minute step.
  const h = new History().create(1, T0, { seedUsdc: 500n, yesBps: 5000, category: 'Crypto', closeMs: T0 + 3 * DAY });
  for (let k = 1; k <= 6; k++) h.buy(1, T0 + k * 15 * MIN - MIN, 'Yes', 10n);
  h.resolve(1, T0 + 2 * DAY, 'Yes');

  const policy = async (env: any) => {
    for (const m of await env.candidateMarkets(env.clock.now(), { minLiquidity: 0, horizonDays: 30 })) {
      await env.buy({ marketId: m.id, direction: 'YES', amount: 100, price: 0.5, marketProb: 0.5, edge: 0.2, kelly: 0.01, forecast: { p: 0.7, ci: { lower: 0.6, upper: 0.8 }, sources: [] }, correlation: {} });
    }
  };
  const cfg = await baseConfig({ from: iso(T0 + 15 * MIN), to: iso(T0 + 90 * MIN) });
  const report = await runBacktest({ events: h.events, signals: [], forecasts: [] }, { ...cfg, to: iso(T0 + 3 * DAY) }, { policy });
  const reset = report.runs.reset!.summary;
  const propagate = report.runs.propagate!.summary;
  assert.ok(reset.buys > 5);
  assert.equal(reset.buys, propagate.buys);
  assert.ok(BigInt(propagate.pnlRaw) < BigInt(reset.pnlRaw), `propagate ${propagate.pnlRaw} < reset ${reset.pnlRaw}`);
  const shares = (run: any) => run.trades.reduce((s: bigint, t: any) => s + BigInt(t.sharesRaw), 0n);
  assert.ok(shares(report.runs.propagate) < shares(report.runs.reset), 'persistent impact makes later fills dearer: fewer shares for the same collateral');
});

test('treasury caps refuse oversized buys and the hits are counted', async () => {
  const { runBacktest } = await import('../src/backtest/engine');
  const { History } = await import('./helpers/backtest-fixture');
  const h = new History().create(1, T0, { seedUsdc: 500n, yesBps: 5000, category: 'Crypto', closeMs: T0 + 3 * DAY });
  const results: string[] = [];
  const policy = async (env: any) => {
    const [m] = await env.candidateMarkets(env.clock.now(), { minLiquidity: 0, horizonDays: 30 });
    for (const amount of [600, 90, 90]) {
      const r = await env.buy({ marketId: m.id, direction: 'YES', amount, price: 0.5, marketProb: 0.5, edge: 0.2, kelly: 0.01, forecast: { p: 0.7, ci: { lower: 0.6, upper: 0.8 }, sources: [] }, correlation: {} });
      results.push(r.ok ? 'ok' : r.reason);
    }
  };
  const report = await runBacktest(
    { events: h.events, signals: [], forecasts: [] },
    await baseConfig({ from: iso(T0 + 15 * MIN), to: iso(T0 + 15 * MIN), maxTradeRaw: 500n * USDC, maxMarketRaw: 5_000n * USDC, maxDailyRaw: 150n * USDC }),
    { impacts: ['reset'], policy },
  );
  assert.deepEqual(results, ['TradeCapExceeded', 'ok', 'DailyCapExceeded']);
  const caps = report.runs.reset!.summary.capHits;
  assert.equal(caps.TradeCapExceeded, 1);
  assert.equal(caps.DailyCapExceeded, 1);
});

test('the backtest script is read-only against the database and runs offline from an events file', async () => {
  const source = readFileSync(join(ROOT, 'scripts', 'backtest.ts'), 'utf8');
  assert.doesNotMatch(source, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRawUnsafe/);
  assert.match(source, /findMany/);

  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const out = mkdtempSync(join(tmpdir(), 'bt-'));
  const run = () => execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', 'scripts/backtest.ts', '--events-file', 'tests/fixtures/backtest/events.json',
      '--out', out],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x' }, encoding: 'utf8' },
  );
  const stdout = run();
  assert.match(stdout, /Impact model: `reset`/);
  assert.match(stdout, /Impact model: `propagate`/);
  assert.ok(existsSync(join(out, 'report.json')) && existsSync(join(out, 'report.md')));
  const first = readFileSync(join(out, 'report.json'), 'utf8');
  run();
  assert.equal(readFileSync(join(out, 'report.json'), 'utf8'), first, 'identical across processes');
  const report = JSON.parse(first);
  assert.ok(BigInt(report.runs.reset.summary.pnlRaw) > 0n);
});
