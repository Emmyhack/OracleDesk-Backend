import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import { USDC, budget, fakeTraderEnv, market, T0 } from './helpers/fake-trader-env';

setupTestEnv();

async function policy() {
  const { DEFAULT_PARAMS, runTraderPolicy } = await import('../src/agents/trader-policy');
  return { params: { ...DEFAULT_PARAMS, headroomSafetyBps: 500 }, run: runTraderPolicy };
}

// With 10 000 USDC free, p_conservative 0.70 vs price 0.55, half-Kelly hits the
// 2.5% position cap: a 250 USDC desired size.

test('kelly size above max_trade is clamped and binding=MAX_TRADE', async () => {
  const { params, run } = await policy();
  const env = fakeTraderEnv({ budget: async () => budget({ maxTradeRaw: 100n * USDC }) });
  await run(env, params);
  assert.equal(env.buys.length, 1);
  const [order] = env.buys;
  assert.equal(order.amountRaw, 100n * USDC);
  assert.equal(order.amount, 100);
  assert.equal(order.sizing.binding, 'MAX_TRADE');
  assert.equal(order.sizing.kellyRaw, (250n * USDC).toString());
  assert.equal(order.sizing.finalRaw, (100n * USDC).toString());
  assert.equal(order.sizing.budget.maxTradeRaw, (100n * USDC).toString());
  assert.equal(typeof order.sizing.budget.readAt, 'string', 'the snapshot is JSON-safe');
});

test('market headroom from TradeAuthorized market_total clamps size', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { marketExposureRaw } = await import('../src/services/treasury-budget.service');
  const orig = prisma.chainEvent.findFirst;
  let where: any;
  (prisma.chainEvent.findFirst as any) = async (args: any) => {
    where = args.where;
    return { params: { market_id: '7', agent: 'G…', amount: '50000000', market_total: '1950000000', daily_total: '1950000000' } };
  };
  try {
    const exposure = await marketExposureRaw('m1', 7n);
    assert.deepEqual(exposure, { totalRaw: 195n * USDC, estimated: false });
    assert.deepEqual(where, {
      contractName: 'treasury', eventName: 'TradeAuthorized', params: { path: ['market_id'], equals: '7' },
    });
  } finally {
    (prisma.chainEvent.findFirst as any) = orig;
  }

  // 300 cap − 195 spent = 105 headroom, minus the 5% margin = 99.75 USDC.
  const { params, run } = await policy();
  const env = fakeTraderEnv({ budget: async () => budget({ maxMarketRaw: 300n * USDC }), exposureRaw: 195n * USDC });
  await run(env, params);
  assert.equal(env.buys[0].amountRaw, 997_500_000n);
  assert.equal(env.buys[0].sizing.binding, 'MAX_MARKET');
  assert.equal(env.buys[0].sizing.marketExposureRaw, (195n * USDC).toString());
});

test('market headroom falls back to DB trades + seed and is marked estimated', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { marketExposureRaw } = await import('../src/services/treasury-budget.service');
  const orig = { ev: prisma.chainEvent.findFirst, trades: prisma.trade.findMany, market: prisma.market.findUnique };
  let eventQueries = 0;
  (prisma.chainEvent.findFirst as any) = async () => { eventQueries++; return null; };
  (prisma.trade.findMany as any) = async ({ where }: any) => {
    assert.deepEqual(where, { marketId: 'm1', status: 'EXECUTED' });
    return [{ amount: 12.5 }, { amount: 7.25 }];
  };
  (prisma.market.findUnique as any) = async () => ({ seedAmountRaw: '500000000' });
  try {
    assert.deepEqual(await marketExposureRaw('m1', 7n), { totalRaw: 697_500_000n, estimated: true });
    assert.equal(eventQueries, 1);
    // A market not on-chain yet has no events to look for.
    assert.deepEqual(await marketExposureRaw('m1', null), { totalRaw: 697_500_000n, estimated: true });
    assert.equal(eventQueries, 1);
  } finally {
    (prisma.chainEvent.findFirst as any) = orig.ev;
    (prisma.trade.findMany as any) = orig.trades;
    (prisma.market.findUnique as any) = orig.market;
  }
});

test('daily remaining with safety margin clamps size; zero remaining skips trade', async () => {
  const { params, run } = await policy();
  // 1 000 cap − 900 used = 100, minus 5% = 95 USDC.
  const tight = fakeTraderEnv({ budget: async () => budget({ maxDailyRaw: 1_000n * USDC, dailyUsedRaw: 900n * USDC }) });
  await run(tight, params);
  assert.equal(tight.buys[0].amountRaw, 95n * USDC);
  assert.equal(tight.buys[0].sizing.binding, 'DAILY');

  const spent = fakeTraderEnv({ budget: async () => budget({ maxDailyRaw: 1_000n * USDC, dailyUsedRaw: 1_000n * USDC }) });
  await run(spent, params);
  assert.equal(spent.buys.length, 0);
  const skip = spent.decisions.find((d) => d.kind === 'SKIP')!;
  assert.equal(skip.data.reason, 'SIZE_BELOW_MIN');
  assert.equal((skip.data.sizing as any).binding, 'DAILY');
});

test('orders in one cycle see the headroom earlier orders used', async () => {
  const { params, run } = await policy();
  const env = fakeTraderEnv({
    budget: async () => budget({ maxDailyRaw: 300n * USDC }),
    markets: [market({ id: 'm1' }), market({ id: 'm2' })],
  });
  await run(env, params);
  assert.deepEqual(env.buys.map((b) => [b.marketId, b.amountRaw, b.sizing.binding]), [
    ['m1', 250n * USDC, 'KELLY'],
    ['m2', 475_000_000n, 'DAILY'], // (300 − 250) × 0.95
  ]);
});

test('correlation cuts are recorded as binding=CORRELATION', async () => {
  const { params, run } = await policy();
  const env = fakeTraderEnv({ correlationKeep: 0.5 });
  await run(env, params);
  assert.equal(env.buys[0].amountRaw, 125n * USDC);
  assert.equal(env.buys[0].sizing.binding, 'CORRELATION');
  assert.equal(env.buys[0].sizing.correlationRaw, (125n * USDC).toString());
});

test('budget read failure skips the cycle and logs TREASURY_READ_FAILED', async () => {
  const { params, run } = await policy();
  const env = fakeTraderEnv({ budget: async () => { throw new Error('rpc unreachable'); } });
  await run(env, params);
  assert.equal(env.buys.length, 0);
  assert.deepEqual(env.calls, ['budget'], 'nothing else runs: no constant fallback');
  assert.equal(env.decisions[0].kind, 'TREASURY_READ_FAILED');
  assert.match(String(env.decisions[0].data.error), /rpc unreachable/);

  // Production writes it to the agent log.
  const { prisma } = await import('../src/lib/prisma');
  const { prodTraderEnv } = await import('../src/agents/trader-env');
  const logs: any[] = [];
  const orig = prisma.agentLog.create;
  (prisma.agentLog.create as any) = async ({ data }: any) => { logs.push(data); return data; };
  try {
    await prodTraderEnv().recordDecision(env.decisions[0]);
    assert.equal(logs[0].action, 'TREASURY_READ_FAILED');
    assert.equal(logs[0].agentType, 'TRADER');
  } finally {
    (prisma.agentLog.create as any) = orig;
  }
});

test('bankroll for drawdown and correlation equals available capital', async () => {
  const { params, run } = await policy();
  // A 40 USDC loss is 4% of 1 000 (pause at 3%) but 0.4% of 10 000.
  const small = fakeTraderEnv({ budget: async () => budget({ availableRaw: 1_000n * USDC }), closedPnl: [-40] });
  await run(small, params);
  assert.equal(small.decisions[0].kind, 'DRAWDOWN_PAUSE');
  assert.equal(small.buys.length, 0);

  const large = fakeTraderEnv({ budget: async () => budget({ availableRaw: 10_000n * USDC }), closedPnl: [-40] });
  await run(large, params);
  assert.ok(!large.decisions.some((d) => d.kind === 'DRAWDOWN_PAUSE'));
  assert.deepEqual(large.correlationBankrolls, [10_000]);
  assert.equal(large.buys[0].sizing.kellyRaw, (250n * USDC).toString(), 'Kelly sizes from available capital');
});

test('a budget older than budgetMaxAgeMs is re-read before the next order', async () => {
  const { params, run } = await policy();
  let t = T0.getTime();
  const env = fakeTraderEnv({ markets: [market({ id: 'm1' }), market({ id: 'm2' })], now: () => new Date((t += 40_000)) });
  await run(env, params);
  assert.ok(env.budgetReads >= 2);
  const fixed = fakeTraderEnv({ markets: [market({ id: 'm1' }), market({ id: 'm2' })] });
  await run(fixed, params);
  assert.equal(fixed.budgetReads, 1);
});

test('readTreasuryBudget mirrors the contract views', async () => {
  const { readTreasuryBudget } = await import('../src/services/treasury-budget.service');
  const b = await readTreasuryBudget({
    availableCapital: async () => 123n,
    getConfig: async () => ({ max_trade: 10n, max_market: 20n, max_daily: 30n }),
    dailyUsage: async () => ({ amount: 45n, day_start: 1_792_310_400n }),
  }, T0);
  assert.equal(b.dailyRemainingRaw, 0n, 'never negative');
  assert.equal(b.dailyUsedRaw, 45n);
  assert.equal(b.dailyWindowStart.toISOString(), new Date(1_792_310_400_000).toISOString());
  assert.equal(b.dailyResetsAt.getTime() - b.dailyWindowStart.getTime(), 86_400_000);
  assert.equal(b.readAt, T0);
});

test('clampSize never returns negative or exceeds any limit (property test over random bigints)', async () => {
  const { clampSize, withSafetyMargin } = await import('../src/services/treasury-budget.service');
  const { mulberry32 } = await import('../src/backtest/rng');
  const rng = mulberry32(76);
  const big = () => {
    const r = rng();
    // Mix of zeros, negatives, small and very large values.
    if (r < 0.05) return 0n;
    if (r < 0.1) return -BigInt(Math.floor(rng() * 1e9));
    return BigInt(Math.floor(rng() * 1e9)) * BigInt(1 + Math.floor(rng() * 1e6));
  };
  for (let i = 0; i < 5_000; i++) {
    const b = budget({ availableRaw: big(), maxTradeRaw: big(), dailyRemainingRaw: big() });
    const desired = big();
    const headroom = big();
    const bps = Math.floor(rng() * 10_000);
    const { sizeRaw, binding } = clampSize(desired, b, headroom, bps);
    const limits = {
      MAX_TRADE: b.maxTradeRaw,
      MAX_MARKET: withSafetyMargin(headroom, bps),
      DAILY: withSafetyMargin(b.dailyRemainingRaw, bps),
      AVAILABLE: b.availableRaw,
    };
    assert.ok(sizeRaw >= 0n, `negative size at case ${i}`);
    assert.ok(sizeRaw <= (desired > 0n ? desired : 0n));
    for (const [name, limit] of Object.entries(limits)) assert.ok(sizeRaw <= (limit > 0n ? limit : 0n), `${name} exceeded at case ${i}`);
    // Maximal: it equals the smallest of the bounds.
    const floor = [desired, ...Object.values(limits)].map((x) => (x > 0n ? x : 0n)).reduce((a, c) => (c < a ? c : a));
    assert.equal(sizeRaw, floor);
    if (binding !== 'KELLY') assert.equal(sizeRaw, (limits as any)[binding] > 0n ? (limits as any)[binding] : 0n);
  }
});

test('executeTrade submits amountRaw without a float round trip', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { setChainOverrides } = await import('../src/services/chain.service');
  const { executeTrade } = await import('../src/services/trade.service');
  const orig = { m: prisma.market.findUnique, p: prisma.position.findFirst, c: prisma.trade.create, u: prisma.trade.update, l: prisma.agentLog.create };
  (prisma.market.findUnique as any) = async () => ({ id: 'm1', onChainMarketId: 7n });
  (prisma.position.findFirst as any) = async () => null;
  (prisma.trade.create as any) = async ({ data }: any) => ({ id: 't1', ...data });
  (prisma.trade.update as any) = async ({ data }: any) => data;
  (prisma.agentLog.create as any) = async ({ data }: any) => data;
  let sent: any;
  const prev = setChainOverrides({
    getOnChainMarket: async () => ({ fee_bps: 100 }) as any,
    quoteBuy: async () => 200_000_000n,
    agentBuy: (async (args: any) => {
      sent = typeof args === 'function' ? await args() : args;
      return { mode: 'dry-run', method: 'agent_buy', value: 200_000_000n, txHash: null };
    }) as any,
  });
  try {
    // 123456789 base units is 12.3456789 USDC; the float says 12.35 on purpose.
    await executeTrade({ marketId: 'm1', direction: 'YES', amount: 12.35, amountRaw: 123_456_789n, price: 0.55, kellyFraction: 0.02, edgeDetected: 0.2 });
    assert.equal(sent.collateral_in, 123_456_789n);
  } finally {
    setChainOverrides(prev);
    (prisma.market.findUnique as any) = orig.m;
    (prisma.position.findFirst as any) = orig.p;
    (prisma.trade.create as any) = orig.c;
    (prisma.trade.update as any) = orig.u;
    (prisma.agentLog.create as any) = orig.l;
  }
});

test('TradeCapExceeded from chain is logged as TREASURY_CAP_REJECTED', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { setChainOverrides } = await import('../src/services/chain.service');
  const { ChainError } = await import('../src/services/stellar/errors');
  const { executeTrade } = await import('../src/services/trade.service');
  const orig = { m: prisma.market.findUnique, p: prisma.position.findFirst, c: prisma.trade.create, u: prisma.trade.update, l: prisma.agentLog.create };
  const logs: any[] = [];
  const updates: any[] = [];
  (prisma.market.findUnique as any) = async () => ({ id: 'm1', onChainMarketId: 7n });
  (prisma.position.findFirst as any) = async () => null;
  (prisma.trade.create as any) = async ({ data }: any) => ({ id: 't1', ...data });
  (prisma.trade.update as any) = async ({ data }: any) => { updates.push(data); return data; };
  (prisma.agentLog.create as any) = async ({ data }: any) => { logs.push(data); return data; };
  const prev = setChainOverrides({
    getOnChainMarket: async () => ({ fee_bps: 100 }) as any,
    agentBuy: (async () => { throw new ChainError('agent_buy failed: TradeCapExceeded', 'TradeCapExceeded', { method: 'agent_buy' }); }) as any,
  });
  const snapshot = { availableRaw: '1', maxTradeRaw: '2', maxMarketRaw: '3', maxDailyRaw: '4', dailyUsedRaw: '0', dailyRemainingRaw: '4', dailyWindowStart: T0.toISOString(), dailyResetsAt: T0.toISOString(), readAt: T0.toISOString() };
  try {
    await assert.rejects(
      executeTrade({ marketId: 'm1', direction: 'NO', amount: 50, amountRaw: 50n * USDC, budget: snapshot, price: 0.45, kellyFraction: 0.02, edgeDetected: -0.2 }),
      (err: any) => err.code === 'TRADE_FAILED',
    );
    const rejected = logs.find((l) => l.action === 'TREASURY_CAP_REJECTED');
    assert.ok(rejected, `actions: ${logs.map((l) => l.action).join(',')}`);
    assert.equal(rejected.level, 'WARN');
    assert.equal(rejected.data.contractError, 'TradeCapExceeded');
    assert.equal(rejected.data.amountRaw, (50n * USDC).toString());
    assert.deepEqual(rejected.data.budget, snapshot);
    assert.equal(updates[updates.length - 1].status, 'FAILED');
  } finally {
    setChainOverrides(prev);
    (prisma.market.findUnique as any) = orig.m;
    (prisma.position.findFirst as any) = orig.p;
    (prisma.trade.create as any) = orig.c;
    (prisma.trade.update as any) = orig.u;
    (prisma.agentLog.create as any) = orig.l;
  }
});
