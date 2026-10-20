import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const RESERVES = { reserve_yes: 4_000_000_000n, reserve_no: 6_000_000_000n, fee_bps: 100 };
const SHARES = 100_000_000n;
const COST = 40_000_000n;

async function harness(opts: { shares?: bigint; held?: bigint; direction?: 'YES' | 'NO'; mode?: 'live' | 'dry-run' } = {}) {
  const { prisma } = await import('../src/lib/prisma');
  const chain = await import('../src/services/chain.service');
  const { config } = await import('../src/config');
  const { calcSell } = await import('../src/generated/fpmm');
  (config as any).CHAIN_EXECUTION_MODE = opts.mode ?? 'live';

  const direction = opts.direction ?? 'YES';
  const state = {
    position: {
      id: 'p1', marketId: 'm1', direction, status: 'OPEN', size: 4,
      sharesRaw: String(opts.shares ?? SHARES), costBasisRaw: COST.toString(),
      realisedCollateralRaw: '0', realisedPnlRaw: '0', closedAt: null as Date | null, closeReason: null as string | null,
      trade: { amount: 4 },
      market: { id: 'm1', onChainMarketId: 9n, expiryTimestamp: new Date(Date.now() + 3 * 86_400_000) },
    } as any,
    exits: [] as any[],
    held: opts.held ?? opts.shares ?? SHARES,
    sellCalls: [] as any[],
    marketReads: 0,
    sellImpl: null as null | ((args: any) => Promise<any>),
  };
  let n = 0;
  (prisma.position.findUnique as any) = async () => ({ ...state.position });
  (prisma.position.findMany as any) = async () => [];
  (prisma.position.update as any) = async ({ data }: any) => { Object.assign(state.position, data); return state.position; };
  (prisma.positionExit.findFirst as any) = async ({ where }: any) =>
    state.exits.find((e) => e.positionId === where.positionId && e.status === where.status) ?? null;
  (prisma.positionExit.create as any) = async ({ data }: any) => {
    const row = { id: `x${++n}`, ...data }; state.exits.push(row); return row;
  };
  (prisma.positionExit.update as any) = async ({ where, data }: any) => {
    const row = state.exits.find((e) => e.id === where.id); Object.assign(row, data); return row;
  };
  // applyConfirmedExit's CONFIRMED transition is a CAS on SUBMITTED (#35).
  (prisma.positionExit.updateMany as any) = async ({ where, data }: any) => {
    const row = state.exits.find((e) => e.id === where.id && (where.status === undefined || e.status === where.status));
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  };
  // Supports both the array form and the interactive callback form (#35).
  (prisma.$transaction as any) = async (ops: any) => (typeof ops === 'function' ? ops(prisma) : Promise.all(ops));
  (prisma.agentLog.create as any) = async () => ({});

  (chain as any).getPosition = async () => (direction === 'YES' ? { yes: state.held, no: 0n } : { yes: 0n, no: state.held });
  (chain as any).getOnChainMarket = async () => { state.marketReads++; return RESERVES; };
  (chain as any).quoteSell = async (_id: bigint, _o: any, collateralOut: bigint) => {
    const [rs, ro] = direction === 'YES' ? [RESERVES.reserve_yes, RESERVES.reserve_no] : [RESERVES.reserve_no, RESERVES.reserve_yes];
    return calcSell(rs, ro, collateralOut, 100n).sharesIn;
  };
  (chain as any).agentSell = async (args: any) => {
    state.sellCalls.push(args);
    if (state.sellImpl) return state.sellImpl(args);
    const [rs, ro] = direction === 'YES' ? [RESERVES.reserve_yes, RESERVES.reserve_no] : [RESERVES.reserve_no, RESERVES.reserve_yes];
    const sharesIn = calcSell(rs, ro, args.collateral_out, 100n).sharesIn;
    state.held -= sharesIn;
    return { mode: opts.mode ?? 'live', method: 'agent_sell', value: sharesIn, txHash: 'cd'.repeat(32) };
  };
  const { ChainError } = await import('../src/services/stellar/errors');
  return { state, ChainError };
}

test('planExit full exit: calcSell(sharesIn) <= sharesTarget and maxSharesIn <= sharesHeld', async () => {
  const { planExit } = await import('../src/services/exit.service');
  const { calcSell } = await import('../src/generated/fpmm');
  for (const outcome of ['YES', 'NO'] as const) {
    const plan = planExit(RESERVES, outcome, SHARES, 100n, SHARES);
    const [rs, ro] = outcome === 'YES' ? [RESERVES.reserve_yes, RESERVES.reserve_no] : [RESERVES.reserve_no, RESERVES.reserve_yes];
    assert.ok(calcSell(rs, ro, plan.collateralOut, 100n).sharesIn <= SHARES);
    assert.equal(plan.quotedSharesIn, calcSell(rs, ro, plan.collateralOut, 100n).sharesIn);
    assert.ok(plan.maxSharesIn <= SHARES);
    assert.ok(plan.maxSharesIn >= plan.quotedSharesIn);
  }
});

test('planExit property: collateralOut round-trips through calcSell within 1 unit', async () => {
  const { planExit } = await import('../src/services/exit.service');
  const { calcSell } = await import('../src/generated/fpmm');
  let seed = 99n;
  const rnd = (max: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 62n); return seed % max; };
  for (let i = 0; i < 200; i++) {
    const m = { reserve_yes: 50_000_000n + rnd(9_000_000_000_000n), reserve_no: 50_000_000n + rnd(9_000_000_000_000n), fee_bps: [0, 30, 100, 500][Number(rnd(4n))] };
    const outcome = i % 2 ? 'YES' : 'NO';
    const held = 100_000n + rnd((outcome === 'YES' ? m.reserve_yes : m.reserve_no) / 2n);
    const plan = planExit(m, outcome, held, 100n, held);
    const [rs, ro] = outcome === 'YES' ? [m.reserve_yes, m.reserve_no] : [m.reserve_no, m.reserve_yes];
    const sale = calcSell(rs, ro, plan.collateralOut, BigInt(m.fee_bps));
    assert.ok(sale.sharesIn <= plan.sharesTarget);
    assert.ok(plan.maxSharesIn <= held);
  }
});

test('planExit halves an unabsorbable target, then reports EXIT_ILLIQUID', async () => {
  const { planExit } = await import('../src/services/exit.service');
  assert.throws(() => planExit({ reserve_yes: 1n, reserve_no: 1n, fee_bps: 100 }, 'YES', 10n ** 12n, 100n), /cannot absorb/);
});

test('live full exit confirms, records collateral and closes at dust', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { state } = await harness();
  const res = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(res.status, 'CONFIRMED');
  assert.equal(res.closed, true);
  assert.equal(state.position.status, 'STOP_LOSS');
  assert.equal(state.position.closeReason, 'STOP_LOSS');
  assert.ok(BigInt(state.position.sharesRaw) <= 1_000n);
  assert.equal(state.position.realisedCollateralRaw, res.collateralOutRaw.toString());
  assert.equal(BigInt(state.position.realisedPnlRaw), res.collateralOutRaw - COST);
  assert.equal(state.exits.length, 1);
  assert.equal(state.exits[0].status, 'CONFIRMED');
  assert.equal(state.sellCalls[0].collateral_out, res.collateralOutRaw);
  assert.ok(state.sellCalls[0].max_shares_in <= SHARES);
});

test('a NO position sells against the NO reserve', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { collateralOutForShares } = await import('../src/generated/fpmm');
  const { state } = await harness({ direction: 'NO' });
  const res = await exitPosition('p1', { reason: 'MANUAL' });
  assert.equal(res.status, 'CONFIRMED');
  const full = collateralOutForShares(RESERVES.reserve_no, RESERVES.reserve_yes, SHARES, 100n);
  assert.ok(res.collateralOutRaw <= full && res.collateralOutRaw >= full - 16n);
  assert.equal(state.position.status, 'CLOSED');
});

test('partial exit (fraction 0.5) leaves the position OPEN with the remaining shares', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { state } = await harness();
  const res = await exitPosition('p1', { reason: 'EDGE_DEGRADED', fraction: 0.5 });
  assert.equal(res.status, 'CONFIRMED');
  assert.equal(res.closed, false);
  assert.equal(state.position.status, 'OPEN');
  const remaining = BigInt(state.position.sharesRaw);
  assert.ok(remaining > 49_000_000n && remaining <= 50_000_000n + 1n);
  // Cost basis is released pro rata, so remaining cost is about half.
  assert.ok(BigInt(state.position.costBasisRaw) >= 19_000_000n && BigInt(state.position.costBasisRaw) <= 21_000_000n);
});

test('SlippageExceeded re-quotes from a fresh market and succeeds on retry', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { calcSell } = await import('../src/generated/fpmm');
  const { state, ChainError } = await harness();
  let calls = 0;
  state.sellImpl = async (args) => {
    if (++calls === 1) throw new ChainError('agent_sell submission failed', 'SlippageExceeded');
    const sharesIn = calcSell(RESERVES.reserve_yes, RESERVES.reserve_no, args.collateral_out, 100n).sharesIn;
    return { mode: 'live', method: 'agent_sell', value: sharesIn, txHash: 'cd'.repeat(32) };
  };
  const res = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(res.status, 'CONFIRMED');
  assert.equal(state.sellCalls.length, 2);
  assert.deepEqual(state.exits.map((e) => e.status), ['FAILED', 'CONFIRMED']);
  assert.ok(state.marketReads >= 2);
});

test('InsufficientShares corrects sharesRaw from get_position and retries', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { calcSell } = await import('../src/generated/fpmm');
  const { state, ChainError } = await harness({ shares: SHARES, held: SHARES });
  let calls = 0;
  state.sellImpl = async (args) => {
    if (++calls === 1) {
      state.held = 60_000_000n; // someone else's exit reduced the balance
      throw new ChainError('agent_sell failed', 'InsufficientShares');
    }
    assert.ok(args.max_shares_in <= 60_000_000n);
    const sharesIn = calcSell(RESERVES.reserve_yes, RESERVES.reserve_no, args.collateral_out, 100n).sharesIn;
    return { mode: 'live', method: 'agent_sell', value: sharesIn, txHash: 'cd'.repeat(32) };
  };
  const res = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(res.status, 'CONFIRMED');
  assert.equal(state.sellCalls.length, 2);
  assert.ok(BigInt(state.position.sharesRaw) <= 1_000n);
});

test('MarketClosed leaves the position OPEN and records EXIT_MARKET_CLOSED', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { state, ChainError } = await harness();
  state.sellImpl = async () => { throw new ChainError('agent_sell failed: MarketClosed', 'MarketClosed'); };
  const res = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(res.status, 'FAILED');
  assert.equal(res.code, 'EXIT_MARKET_CLOSED');
  assert.equal(state.position.status, 'OPEN');
  assert.equal(state.sellCalls.length, 1);
  assert.match(state.exits[0].error, /EXIT_MARKET_CLOSED/);
});

test('Paused fails without retry', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { state, ChainError } = await harness();
  state.sellImpl = async () => { throw new ChainError('agent_sell failed: Paused', 'Paused'); };
  const res = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(res.code, 'EXIT_PAUSED');
  assert.equal(state.sellCalls.length, 1);
});

test('exits within 60s of close_time are left to settlement', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { state } = await harness();
  state.position.market.expiryTimestamp = new Date(Date.now() + 30_000);
  const res = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(res.code, 'EXIT_MARKET_CLOSED');
  assert.equal(state.sellCalls.length, 0);
});

test('dry-run records SIMULATED and does not change the position', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { state } = await harness({ mode: 'dry-run' });
  const res = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(res.status, 'SIMULATED');
  assert.equal(state.exits[0].status, 'SIMULATED');
  assert.equal(state.position.status, 'OPEN');
  assert.equal(state.position.sharesRaw, SHARES.toString());
  assert.equal(state.position.realisedCollateralRaw, '0');
});

test('an ambiguous submission stays SUBMITTED and blocks a second exit until reconciled', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { calcSell } = await import('../src/generated/fpmm');
  const { state, ChainError } = await harness();
  state.sellImpl = async () => { throw new ChainError('agent_sell submission failed', null, { cause: 'timeout' }); };
  const first = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(first.status, 'SUBMITTED');
  assert.equal(state.exits[0].status, 'SUBMITTED');
  assert.equal(state.position.status, 'OPEN');

  // The chain balance can't be read: the exit stays blocking, nothing is sold twice.
  const chain = await import('../src/services/chain.service');
  const realGetPosition = (chain as any).getPosition;
  (chain as any).getPosition = async () => { throw new Error('rpc down'); };
  const blocked = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(blocked.code, 'EXIT_PENDING_RECONCILE');
  assert.equal(state.sellCalls.length, 1);
  (chain as any).getPosition = realGetPosition;

  // The transaction had landed: the balance dropped, so the next call confirms it instead of selling again.
  const sold = calcSell(RESERVES.reserve_yes, RESERVES.reserve_no, BigInt(state.exits[0].collateralOutRaw), 100n).sharesIn;
  state.held = SHARES - sold;
  const reconciled = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(reconciled.closed, true);
  assert.equal(state.exits[0].status, 'CONFIRMED');
  assert.equal(state.sellCalls.length, 1);
});

test('a SUBMITTED exit whose balance never moved is marked not landed and a fresh exit proceeds', async () => {
  const { exitPosition } = await import('../src/services/exit.service');
  const { state, ChainError } = await harness();
  state.sellImpl = async () => { throw new ChainError('agent_sell submission failed', null); };
  await exitPosition('p1', { reason: 'STOP_LOSS' });
  state.sellImpl = null;
  const res = await exitPosition('p1', { reason: 'STOP_LOSS' });
  assert.equal(res.status, 'CONFIRMED');
  assert.match(state.exits[0].error, /EXIT_RECONCILED_NOT_LANDED/);
  assert.equal(state.exits[0].status, 'FAILED');
});

test('stop-loss in runTraderCycle calls exitPosition, not closePosition', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const controls = await import('../src/services/agent-controls.service');
  const hedging = await import('../src/services/hedging.service');
  const valuation = await import('../src/services/valuation.service');
  const exit = await import('../src/services/exit.service');
  const trade = await import('../src/services/trade.service');
  const ingestion = await import('../src/services/ingestion.service');
  const { runTraderCycle } = await import('../src/agents/trader.agent');

  const exited: any[] = [];
  let closed = 0;
  (controls as any).gateCycle = async () => 1;
  (controls as any).assertAgentActive = async () => 1;
  (hedging as any).checkDailyDrawdown = async () => ({ isPaused: false, drawdownPct: 0 });
  (hedging as any).enforceStopLoss = async () => ({ shouldClose: true, reason: 'STOP_LOSS: test' });
  (hedging as any).detectHedgeOpportunities = async () => [];
  (valuation as any).markOpenPositions = async () => ({ marked: 1, skippedMarkets: 0 });
  (exit as any).exitPosition = async (id: string, opts: any) => { exited.push({ id, opts }); return { status: 'CONFIRMED', exitId: 'x' }; };
  (trade as any).closePosition = async () => { closed++; };
  (ingestion as any).aggregateSignals = async () => ({ news: [], fed: [], macro: [], signalCount: 0 });
  (prisma.position.findMany as any) = async () => [{ id: 'p9' }];
  (prisma.market.findMany as any) = async () => [];
  (prisma.agentLog.create as any) = async () => ({});
  // The cycle sizes from the treasury (#76) and skips entirely without it.
  const budget = await import('../src/services/treasury-budget.service');
  (budget as any).readTreasuryBudget = async () => ({
    availableRaw: 100_000_000_000n, maxTradeRaw: 10n ** 12n, maxMarketRaw: 10n ** 12n, maxDailyRaw: 10n ** 12n,
    dailyUsedRaw: 0n, dailyRemainingRaw: 10n ** 12n, dailyWindowStart: new Date(), dailyResetsAt: new Date(), readAt: new Date(),
  });

  await runTraderCycle();
  assert.deepEqual(exited, [{ id: 'p9', opts: { reason: 'STOP_LOSS' } }]);
  assert.equal(closed, 0);
});
