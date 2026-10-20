import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const vectors = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'fpmm-valuation.json'), 'utf8'),
).vectors as Array<{
  reserveYes: string; reserveNo: string; feeBps: number; shares: string;
  priceYesBps: number; yesLiquidation: string | null; noLiquidation: string | null;
}>;

const reserves = (reserveYes: bigint, reserveNo: bigint, feeBps = 100n) =>
  ({ reserveYes, reserveNo, feeBps, asOfLedger: 1, source: 'rpc' as const });

test('valuePosition uses the sold side first for YES and NO', async () => {
  const { valuePosition } = await import('../src/services/valuation.service');
  const { collateralOutForShares } = await import('../src/generated/fpmm');
  const r = reserves(3_000_000_000n, 1_000_000_000n);
  const shares = 100_000_000n;
  const yes = valuePosition('YES', shares, 0n, r);
  const no = valuePosition('NO', shares, 0n, r);
  assert.equal(yes.liquidationValueRaw, collateralOutForShares(3_000_000_000n, 1_000_000_000n, shares, 100n));
  assert.equal(no.liquidationValueRaw, collateralOutForShares(1_000_000_000n, 3_000_000_000n, shares, 100n));
  assert.notEqual(yes.liquidationValueRaw, no.liquidationValueRaw);
  // reserve_no is large when YES is cheap... here YES reserve is large so YES is the cheap side.
  assert.equal(yes.priceBps, 2_500n);
  assert.equal(no.priceBps, 7_500n);
  assert.equal(yes.midValueRaw, (shares * 2_500n) / 10_000n);
  assert.equal(yes.unrealisedPnlRaw, yes.liquidationValueRaw - 0n);
});

test('liquidation value never exceeds mid value (property)', async () => {
  const { valuePosition } = await import('../src/services/valuation.service');
  let seed = 12345n;
  const rnd = (max: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 62n); return seed % max; };
  for (let i = 0; i < 300; i++) {
    const rYes = 10_000_000n + rnd(9_000_000_000_000n);
    const rNo = 10_000_000n + rnd(9_000_000_000_000n);
    const fee = [0n, 30n, 100n, 500n][Number(rnd(4n))];
    const shares = 10_000n + rnd(rYes / 3n + 1n);
    for (const outcome of ['YES', 'NO'] as const) {
      const v = valuePosition(outcome, shares, 0n, reserves(rYes, rNo, fee));
      if (v.illiquid) continue;
      assert.ok(v.liquidationValueRaw <= v.midValueRaw, `${outcome} ${rYes}/${rNo} fee ${fee} shares ${shares}`);
    }
  }
});

test('matches the Python FPMM model vectors exactly', async () => {
  const { valuePosition } = await import('../src/services/valuation.service');
  assert.ok(vectors.length >= 40);
  for (const v of vectors) {
    const r = reserves(BigInt(v.reserveYes), BigInt(v.reserveNo), BigInt(v.feeBps));
    const shares = BigInt(v.shares);
    const yes = valuePosition('YES', shares, 0n, r);
    const no = valuePosition('NO', shares, 0n, r);
    assert.equal(yes.priceBps, BigInt(v.priceYesBps));
    assert.equal(no.priceBps, 10_000n - BigInt(v.priceYesBps));
    if (v.yesLiquidation === null) assert.equal(yes.illiquid, true);
    else assert.equal(yes.liquidationValueRaw.toString(), v.yesLiquidation);
    if (v.noLiquidation === null) assert.equal(no.illiquid, true);
    else assert.equal(no.liquidationValueRaw.toString(), v.noLiquidation);
  }
});

test('an illiquid position values to 0 with the flag and scenario values', async () => {
  const { valuePosition } = await import('../src/services/valuation.service');
  // A one-unit pool can't pay out any whole unit for a huge sale.
  const shares = 10n ** 12n;
  const v = valuePosition('YES', shares, 5_000_000n, reserves(1n, 1n));
  assert.equal(v.illiquid, true);
  assert.equal(v.liquidationValueRaw, 0n);
  assert.equal(v.unrealisedPnlRaw, -5_000_000n);
  assert.deepEqual(v.settlementValueRaw, { yes: shares, no: 0n, void: shares / 2n });
});

test('latestReserves prefers a fresh indexed Trade event and falls back to rpc', async () => {
  const { latestReserves, clearFeeCacheForTest } = await import('../src/services/valuation.service');
  clearFeeCacheForTest();
  let marketReads = 0;
  const base = {
    newestTradeEvent: async () => ({ ledger: 777, params: { reserve_yes: '123', reserve_no: '456' } }),
    getMarket: async () => { marketReads++; return { reserve_yes: 10n, reserve_no: 20n, fee_bps: 100 }; },
    indexerFresh: () => true,
  };
  const indexed = await latestReserves(1n, 120, base);
  assert.deepEqual([indexed.source, indexed.reserveYes, indexed.reserveNo, indexed.asOfLedger, indexed.feeBps], ['indexed', 123n, 456n, 777, 100n]);
  assert.equal(marketReads, 1); // fee only
  await latestReserves(1n, 120, base);
  assert.equal(marketReads, 1); // fee cached

  clearFeeCacheForTest();
  const stale = await latestReserves(2n, 120, { ...base, indexerFresh: () => false });
  assert.deepEqual([stale.source, stale.reserveYes, stale.reserveNo], ['rpc', 10n, 20n]);
  const none = await latestReserves(3n, 120, { ...base, newestTradeEvent: async () => null });
  assert.equal(none.source, 'rpc');
});

function stubPrisma(prisma: any, positions: any[]) {
  const updates: any[] = [];
  prisma.position.findMany = async () => positions;
  prisma.position.update = async (args: any) => { updates.push(args); return args; };
  return updates;
}

const openPosition = (id: string, onChainMarketId: bigint, direction: 'YES' | 'NO', shares: string, cost: string, extra: any = {}) => ({
  id, direction, sharesRaw: shares, costBasisRaw: cost, realisedPnlRaw: '0',
  market: { id: `m${onChainMarketId}`, onChainMarketId, status: 'ACTIVE' }, ...extra,
});

test('markOpenPositions fetches reserves once per market and derives display floats', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { markOpenPositions, clearFeeCacheForTest } = await import('../src/services/valuation.service');
  clearFeeCacheForTest();
  const updates = stubPrisma(prisma, [
    openPosition('a', 1n, 'YES', '100000000', '60000000'),
    openPosition('b', 1n, 'NO', '50000000', '30000000'),
    openPosition('c', 2n, 'YES', '10000000', '5000000'),
  ]);
  const reads: bigint[] = [];
  const out = await markOpenPositions({
    newestTradeEvent: async () => null,
    getMarket: async (id) => { reads.push(id); return { reserve_yes: 1_000_000_000n, reserve_no: 1_000_000_000n, fee_bps: 100 }; },
    indexerFresh: () => false,
  });
  assert.equal(out.marked, 3);
  assert.deepEqual(reads.sort(), [1n, 2n]);
  const a = updates.find((u) => u.where.id === 'a').data;
  assert.equal(a.markPriceBps, 5000);
  assert.equal(a.markValueRaw, '50000000');
  assert.equal(a.valuationSource, 'rpc');
  assert.equal(a.currentPrice, 0.5);
  assert.equal(a.unrealisedPnlRaw, (BigInt(a.liquidationValueRaw) - 60_000_000n).toString());
});

test('stop-loss fires on a 15% liquidation loss, not on the mid price', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { enforceStopLoss } = await import('../src/services/hedging.service');
  const row = (unrealised: string) => ({ id: 'p', status: 'OPEN', entryPrice: 0.5, currentPrice: 0.5, costBasisRaw: '100000000', unrealisedPnlRaw: unrealised });
  let current = row('-14999999');
  (prisma.position.findUnique as any) = async () => current;
  assert.equal((await enforceStopLoss('p')).shouldClose, false);
  current = row('-15000000');
  const hit = await enforceStopLoss('p');
  assert.equal(hit.shouldClose, true);
  assert.match(hit.reason!, /15\.0%/);
  // Legacy rows without shares keep the price rule.
  (prisma.position.findUnique as any) = async () => ({ id: 'p', status: 'OPEN', entryPrice: 0.5, currentPrice: 0.4, costBasisRaw: null, unrealisedPnlRaw: null });
  assert.equal((await enforceStopLoss('p')).shouldClose, true);
});

test('executeTrade stores sharesRaw / costBasisRaw / feesPaidRaw from agentBuy', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const chain = await import('../src/services/chain.service');
  const { executeTrade } = await import('../src/services/trade.service');
  const created: any[] = [];
  // The trade row as applyBuySuccess (#35) reads and transitions it.
  const trade: any = { id: 't1', marketId: 'm', direction: 'YES', amount: 2, status: 'PENDING' };
  (prisma.market.findUnique as any) = async () => ({ id: 'm', onChainMarketId: 7n });
  (prisma.position.findFirst as any) = async () => null;
  (prisma.trade.create as any) = async ({ data }: any) => Object.assign(trade, data, { id: 't1' });
  (prisma.trade.update as any) = async ({ data }: any) => Object.assign(trade, data);
  (prisma.trade.findUnique as any) = async () => ({ ...trade });
  (prisma.trade.updateMany as any) = async ({ where, data }: any) => {
    if (where.status?.in && !where.status.in.includes(trade.status)) return { count: 0 };
    Object.assign(trade, data);
    return { count: 1 };
  };
  (prisma.position.create as any) = async ({ data }: any) => { created.push(data); return data; };
  (prisma.position.findUnique as any) = async () => created[0] ?? null;
  (prisma.$transaction as any) = async (ops: Promise<unknown>[]) => Promise.all(ops);
  (prisma.agentLog.create as any) = async () => ({});
  (chain as any).quoteBuy = async () => 18_000_000n;
  (chain as any).getOnChainMarket = async () => ({ fee_bps: 100, reserve_yes: 1n, reserve_no: 1n });
  let buyArgs: any;
  // agentBuy takes a thunk so a retry re-quotes min_shares_out (#40).
  (chain as any).agentBuy = async (args: any) => { buyArgs = typeof args === 'function' ? await args() : args; return { mode: 'live', method: 'agent_buy', value: 19_000_000n, txHash: 'ab'.repeat(32) }; };

  await executeTrade({ marketId: 'm', direction: 'YES', amount: 2, price: 0.1, kellyFraction: 0.01, edgeDetected: 0.2 } as any);
  assert.equal(buyArgs.collateral_in, 20_000_000n);
  assert.equal(created.length, 1);
  assert.equal(created[0].sharesRaw, '19000000');
  assert.equal(created[0].costBasisRaw, '20000000');
  assert.equal(created[0].feesPaidRaw, '200000'); // ceil(20_000_000 × 100 / 10_000)
  assert.ok(Math.abs(created[0].entryPrice - 20 / 19) < 1 || created[0].entryPrice <= 1);
  assert.equal(created[0].entryPrice, 1); // 20/19 clamps to 1 (fee-dominated edge case)
});

test('decimalToBigint round-trips 39-digit values and rejects non-integers', async () => {
  const { decimalToBigint, bigintToDecimalString } = await import('../src/lib/amounts');
  const { Prisma } = await import('@prisma/client');
  const big = 10n ** 38n + 123456789n;
  assert.equal(decimalToBigint(new Prisma.Decimal(big.toString())), big);
  assert.equal(decimalToBigint(bigintToDecimalString(-big)), -big);
  assert.equal(decimalToBigint('42.000'), 42n);
  assert.throws(() => decimalToBigint('1.5'));
  assert.throws(() => decimalToBigint('1e3'));
});

test('portfolio summary uses cost basis and liquidation-based PnL', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { getPortfolioSummary } = await import('../src/services/portfolio.service');
  (prisma.position.findMany as any) = async ({ where }: any) =>
    where.status === 'OPEN'
      ? [
          { size: 99, pnl: 0, costBasisRaw: '100000000', realisedPnlRaw: '5000000', unrealisedPnlRaw: '-20000000' },
          { size: 10, pnl: -1, costBasisRaw: null, realisedPnlRaw: '0', unrealisedPnlRaw: null },
        ]
      : [{ pnl: 2, closedAt: new Date(0) }];
  (prisma.trade.aggregate as any) = async () => ({ _sum: { builderFee: 0 } });
  const s = await getPortfolioSummary(null);
  assert.equal(s.deployedCapital, 20); // 10 USDC cost basis + 10 legacy size
  assert.equal(s.totalPnl, -1 + 2 + (0.5 - 2)); // legacy -1, closed +2, open realised 0.5 + unrealised -2 (USDC)
});

test('backfill fills from indexed events, estimates otherwise and reports skips', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { backfillPositionShares } = await import('../src/services/position-backfill.service');
  const { calcBuy } = await import('../src/generated/fpmm');
  const base = { executedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01'), status: 'EXECUTED' };
  const rows = [
    { id: 'exact', direction: 'YES', trade: { ...base, txHash: 'aa'.repeat(32), amount: 2 }, market: { onChainMarketId: 1n, seedAmountRaw: null, initialYesProb: 0.5 } },
    { id: 'est', direction: 'NO', trade: { ...base, txHash: 'bb'.repeat(32), amount: 3 }, market: { onChainMarketId: 1n, seedAmountRaw: null, initialYesProb: 0.5 } },
    { id: 'dry', direction: 'YES', trade: { ...base, txHash: null, amount: 1 }, market: { onChainMarketId: 1n, seedAmountRaw: null, initialYesProb: 0.5 } },
  ];
  const updates: any[] = [];
  (prisma.position.findMany as any) = async () => rows;
  (prisma.position.update as any) = async (a: any) => { updates.push(a); return a; };
  const deps = {
    findTradeEvent: async (tx: string) => (tx.startsWith('aa') ? { shares: 19_000_000n, collateral: 20_000_000n, fee: 200_000n } : null),
    previousReserves: async () => ({ reserveYes: 1_000_000_000n, reserveNo: 2_000_000_000n }),
    feeBps: async () => 100n,
  };
  const report = await backfillPositionShares(deps);
  assert.deepEqual([report.exact, report.estimated, report.skipped.length], [1, 1, 1]);
  assert.equal(report.skipped[0].positionId, 'dry');
  const exact = updates.find((u) => u.where.id === 'exact').data;
  assert.deepEqual([exact.sharesRaw, exact.costBasisRaw, exact.feesPaidRaw, exact.valuationSource], ['19000000', '20000000', '200000', 'indexed']);
  const est = updates.find((u) => u.where.id === 'est').data;
  const q = calcBuy(2_000_000_000n, 1_000_000_000n, 30_000_000n, 100n); // NO buys the NO reserve
  assert.deepEqual([est.sharesRaw, est.valuationSource], [q.sharesOut.toString(), 'estimated']);
});

test('executeTrade cancels the trade, not fails it, when the agent is paused (#79)', async () => {
  const chain = await import('../src/services/chain.service');
  const { prisma } = await import('../src/lib/prisma');
  const { executeTrade } = await import('../src/services/trade.service');
  const { AgentPausedError } = await import('../src/services/agent-controls.service');
  const updates: any[] = [];
  let positions = 0;
  (prisma.market.findUnique as any) = async () => ({ id: 'm1', onChainMarketId: 3n });
  (prisma.position.findFirst as any) = async () => null;
  (prisma.trade.create as any) = async ({ data }: any) => ({ id: 't1', ...data });
  (prisma.trade.update as any) = async ({ data }: any) => { updates.push(data); return {}; };
  (prisma.position.create as any) = async () => { positions += 1; return {}; };
  (prisma.agentLog as any).create = async () => ({});
  (chain as any).quoteBuy = async () => 120_000_000n;
  (chain as any).getOnChainMarket = async () => ({ fee_bps: 30 });
  (chain as any).agentBuy = async () => { throw new AgentPausedError('TRADER', { reason: 'halt' }); };
  await assert.rejects(
    executeTrade({ marketId: 'm1', direction: 'YES', amount: 10, price: 0.5, kellyFraction: 0.1, edgeDetected: 0.2 } as any),
    (e: any) => e.code === 'AGENT_PAUSED',
  );
  assert.equal(updates[0].status, 'CANCELLED');
  assert.equal(positions, 0);
});
