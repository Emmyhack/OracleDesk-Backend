import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const USDC = 10_000_000n;
const NOW = new Date('2026-10-18T12:00:00Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

const CFG = {
  lpLossBudgetRaw: 10_000n * USDC, // out of the way unless a test narrows it
  mmDailyShareBps: 4000,
  maxSeedFractionBps: 500,
  maxUnresolvedSeededRaw: 100_000n * USDC,
  categoryBaseUsdc: { FED: 300, CRYPTO: 200, ENTERTAINMENT: 100 } as Record<string, number>,
  feeBps: 200,
};

function input(over: Record<string, any> = {}): any {
  return {
    category: 'FED',
    closeTime: inDays(30),
    now: NOW,
    p: 0.62,
    ci: { lower: 0.55, upper: 0.69 },
    llmSuggestedSeedUsdc: 1000,
    budget: {
      availableRaw: 1_000_000n * USDC,
      maxTradeRaw: 10_000n * USDC,
      maxMarketRaw: 10_000n * USDC,
      maxDailyRaw: 100_000n * USDC,
      dailyUsedRaw: 0n,
      mmSeededTodayRaw: 0n,
      ...(over.budget ?? {}),
    },
    unresolvedSeededRaw: 0n,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'budget')),
  };
}

test('a wide CI shrinks the opening price toward 0.5; a narrow one keeps it', async () => {
  const { shrinkInitialPrice } = await import('../src/services/seed-policy.service');
  assert.equal(shrinkInitialPrice(0.8, { lower: 0.8, upper: 0.8 }), 0.8, 'no uncertainty, no shrink');
  const narrow = shrinkInitialPrice(0.8, { lower: 0.75, upper: 0.85 });
  const wide = shrinkInitialPrice(0.8, { lower: 0.3, upper: 0.99 });
  assert.ok(Math.abs(narrow - 0.8) < 0.03, `narrow ${narrow}`);
  assert.equal(wide, 0.65, 'width ≥ 0.6 shrinks the distance from 0.5 by half');
  assert.ok(wide < narrow && wide > 0.5);
  assert.equal(shrinkInitialPrice(0.2, { lower: 0, upper: 1 }), 0.35, 'symmetric below 0.5');
});

test('the seed never exceeds any of its bounds, and the binding bound is named', async () => {
  const { decideSeed, MIN_SEED_RAW } = await import('../src/services/seed-policy.service');
  const run = (over: Record<string, any>) => decideSeed(input(over), CFG) as any;

  const base = run({});
  assert.equal(base.action, 'create');
  assert.equal(base.binding, 'BASE');
  assert.equal(base.seedRaw, 300n * USDC, 'FED at 30 days: factor 1');
  assert.equal(base.initialYesBps, Math.round(base.pAdj * 10_000));

  const trade = run({ budget: { maxTradeRaw: 200n * USDC } });
  assert.equal(trade.binding, 'MAX_TRADE');
  assert.equal(trade.seedRaw, 190n * USDC, '5% safety margin');

  const market = run({ budget: { maxMarketRaw: 160n * USDC } });
  assert.equal(market.binding, 'MAX_MARKET');
  assert.ok(market.seedRaw <= 160n * USDC);

  // Daily: the market maker's 40% share of 1 000 USDC is 400, 250 already used by its own seeds.
  const share = run({ budget: { maxDailyRaw: 1000n * USDC, mmSeededTodayRaw: 250n * USDC } });
  assert.equal(share.seedRaw, 150n * USDC);
  assert.equal(share.binding, 'MM_DAILY_SHARE');

  // The trader's spend counts against the total headroom even though it is not the market maker's.
  const headroom = run({ budget: { maxDailyRaw: 1000n * USDC, dailyUsedRaw: 800n * USDC } });
  assert.equal(headroom.binding, 'DAILY_HEADROOM');
  assert.equal(headroom.seedRaw, 190n * USDC);

  const fraction = run({ budget: { availableRaw: 5000n * USDC } });
  assert.equal(fraction.binding, 'AVAILABLE_FRACTION');
  assert.equal(fraction.seedRaw, 250n * USDC, '5% of 5 000');

  const aggregate = run({ unresolvedSeededRaw: 99_850n * USDC });
  assert.equal(aggregate.binding, 'AGGREGATE_CAP');
  assert.equal(aggregate.seedRaw, 150n * USDC);

  for (const d of [trade, market, share, headroom, fraction, aggregate]) assert.ok(d.seedRaw >= MIN_SEED_RAW);
});

test('a seed below MIN_SEED_RAW is a skip that names the binding reason', async () => {
  const { decideSeed } = await import('../src/services/seed-policy.service');
  const reason = (over: Record<string, any>, cfg = CFG) => (decideSeed(input(over), cfg) as any);

  assert.equal(reason({ budget: { maxTradeRaw: 90n * USDC } }).reason, 'BELOW_MIN_SEED');
  assert.equal(reason({ budget: { maxDailyRaw: 200n * USDC } }).reason, 'DAILY_BUDGET');
  assert.equal(reason({ budget: { maxDailyRaw: 1000n * USDC, dailyUsedRaw: 950n * USDC } }).reason, 'DAILY_BUDGET');
  assert.equal(reason({ budget: { availableRaw: 1000n * USDC } }).reason, 'INSUFFICIENT_CAPITAL');
  assert.equal(reason({ unresolvedSeededRaw: 99_950n * USDC }).reason, 'AGGREGATE_CAP');
  assert.equal(reason({}, { ...CFG, lpLossBudgetRaw: 1n * USDC }).reason, 'LP_LOSS_BUDGET');
  const skipped = reason({ budget: { maxTradeRaw: 90n * USDC } });
  assert.ok(skipped.inputs.bound_MAX_TRADE, 'inputs are recorded for the SEED_SKIPPED log');
});

test('expected LP loss is monotonic in the seed and in the distance to the CI bound', async () => {
  const { expectedLpLoss } = await import('../src/services/seed-policy.service');
  const loss = (seed: bigint, open: number, target: number) => expectedLpLoss(seed * USDC, open, target, 200);

  let prev = -1n;
  for (const s of [100n, 200n, 400n, 800n, 1600n]) {
    const l = loss(s, 5000, 6500);
    assert.ok(l > prev, `seed ${s}`);
    prev = l;
  }
  prev = -1n;
  for (const target of [5200, 5600, 6000, 6800, 7600]) {
    const l = loss(300n, 5000, target);
    assert.ok(l > prev, `target ${target}`);
    prev = l;
  }
  // Symmetric: pushing down by the same distance costs about the same.
  const up = loss(300n, 5000, 6500);
  const down = loss(300n, 5000, 3500);
  assert.ok(up > 0n && down > 0n);
  const ratio = Number(up) / Number(down);
  assert.ok(ratio > 0.9 && ratio < 1.1, `ratio ${ratio}`);
  assert.equal(loss(300n, 5000, 5000), 0n, 'price already at the target');
  assert.equal(expectedLpLoss(0n, 5000, 6000, 200), 0n);
});

test('the LP-loss bisection finds the largest seed within 1 USDC of the budget', async () => {
  const { decideSeed, expectedLpLoss } = await import('../src/services/seed-policy.service');
  const budget = 40n * USDC; // a 100 USDC seed loses ~29 here, 300 loses ~87
  const d = decideSeed(input({ ci: { lower: 0.3, upper: 0.9 }, p: 0.6 }), { ...CFG, lpLossBudgetRaw: budget }) as any;
  assert.equal(d.action, 'create');
  assert.equal(d.binding, 'LP_LOSS_BUDGET');
  assert.ok(d.seedRaw < 300n * USDC);
  assert.ok(d.expectedLpLossRaw <= budget);

  const open = d.initialYesBps;
  const target = d.inputs.worstCaseTargetBps as number;
  assert.ok(expectedLpLoss(d.seedRaw, open, target, 200) <= budget);
  assert.ok(expectedLpLoss(d.seedRaw + USDC, open, target, 200) > budget, 'one USDC more would break the budget');
  // The loss is computed with the contract's integer math: same function, same result.
  assert.equal(d.expectedLpLossRaw, expectedLpLoss(d.seedRaw, open, target, 200));
});

test('the LLM suggestion can lower the base seed but not raise it', async () => {
  const { decideSeed } = await import('../src/services/seed-policy.service');
  const seed = (llm: number, category = 'FED') => (decideSeed(input({ llmSuggestedSeedUsdc: llm, category }), CFG) as any).seedRaw;
  assert.equal(seed(100_000), 300n * USDC, 'a huge suggestion is capped at the category base');
  assert.equal(seed(120), 240n * USDC, 'at most 2× the suggestion');
  assert.equal(seed(10), 100n * USDC, 'never below the on-chain MIN_SEED');
  assert.equal(seed(100_000, 'ENTERTAINMENT'), 100n * USDC);
});

test('time to close scales the base seed between 0.5× and 1.5×', async () => {
  const { decideSeed } = await import('../src/services/seed-policy.service');
  const seed = (days: number) => (decideSeed(input({ closeTime: inDays(days), category: 'CRYPTO', llmSuggestedSeedUsdc: 10_000 }), CFG) as any).seedRaw;
  assert.equal(seed(1), 100n * USDC, '0.5× of 200');
  assert.equal(seed(30), 200n * USDC);
  assert.equal(seed(120), 300n * USDC, 'capped at 1.5×');
  assert.ok(seed(60) > seed(30));
});

// ─── Market maker cycle ──────────────────────────────────────────────────────

async function cycleHarness(opts: { budgetFails?: boolean; maxTradeUsdc?: number } = {}) {
  const { prisma } = await import('../src/lib/prisma');
  const { setIpfsTransport, cidForBytes } = await import('../src/services/ipfs.service');
  const { setContentStore } = await import('../src/services/content-store.service');
  const ingestion = await import('../src/services/ingestion.service');
  const marketSvc = await import('../src/services/market.service');
  const chain = await import('../src/services/chain.service');
  const reasoning = await import('../src/services/reasoning.service');
  const publish = await import('../src/services/trace-publish.service');
  const budget = await import('../src/lib/llm-budget');

  const seen = { pins: 0, creates: [] as any[], updates: [] as any[], chainCreates: [] as any[], logs: [] as any[], traces: [] as any[] };
  setIpfsTransport({
    pin: async (bytes) => { seen.pins++; return cidForBytes(bytes); },
    fetch: async () => Buffer.alloc(0),
  });
  setContentStore({ put: async () => undefined, get: async () => null, touch: async () => undefined, evict: async () => ({ removed: 0, freedBytes: 0 }) });

  (ingestion as any).aggregateSignals = async () => ({ news: [{ source: 'NEWSAPI', title: 'Fed holds', content: '', publishedAt: '', relevanceScore: 0.6, category: 'FED' }], fed: [], macro: [], aggregatedAt: new Date(), signalCount: 1 });
  (marketSvc as any).generateMarketQuestion = async () => ({
    market_question: 'Will the Fed cut rates in December?',
    initial_yes_probability: 0.7,
    resolution_oracle: 'FRED',
    expiry_timestamp: Math.floor(Date.now() / 1000) + 30 * 86_400,
    settlement_currency: 'USDC',
    minimum_liquidity_usdc: 50_000, // the LLM asks for far too much
    category: 'FED',
    confidence_interval: { lower: 0.55, upper: 0.85 },
    reasoning: 'r',
    grounding_signal_ids: [],
  });
  (marketSvc as any).isDuplicateMarket = async () => false;

  const maxTrade = BigInt(Math.round((opts.maxTradeUsdc ?? 5000) * 1e7));
  (chain as any).treasuryConfig = async () => {
    if (opts.budgetFails) throw new Error('rpc down');
    return { max_trade: maxTrade, max_market: 100_000n * USDC, max_daily: 100_000n * USDC };
  };
  (chain as any).treasuryDailyUsage = async () => ({ amount: 0n, day_start: 0n });
  (chain as any).treasuryAvailableCapital = async () => 1_000_000n * USDC;
  (chain as any).marketCoreConfig = async () => ({ default_fee_bps: 200 });
  (chain as any).agentCreateMarket = async (args: any) => {
    seen.chainCreates.push(args);
    return { mode: 'live', method: 'agent_create_market', value: 42n, txHash: 'cd'.repeat(32) };
  };
  (reasoning as any).generateReasoningTrace = async (input: any) => {
    seen.traces.push(input);
    return { trace: { id: 'trace-1' }, tracePayload: { traceId: 'trace-1', seedPolicy: input.seedPolicy } };
  };
  (publish as any).enqueueTracePublication = async () => undefined;
  (budget as any).getLlmUsage = async () => ({}); // would otherwise wait on Redis
  (budget as any).claimDailyOnce = async () => false;

  (prisma.market.findMany as any) = async () => [];
  (prisma.market.create as any) = async ({ data }: any) => { const m = { id: 'm-new', createdAt: new Date(), seedAmountRaw: null, ...data }; seen.creates.push(m); return m; };
  (prisma.market.update as any) = async ({ data }: any) => { seen.updates.push(data); return { id: 'm-new', question: 'Will the Fed cut rates in December?', category: 'FED', expiryTimestamp: new Date(Date.now() + 30 * 86_400_000), initialYesProb: seen.creates[0]?.initialYesProb ?? 0.7, minimumLiquidity: seen.creates[0]?.minimumLiquidity ?? 100, resolutionOracle: 'FRED', ...data }; };
  (prisma.agentLog.create as any) = async ({ data }: any) => { seen.logs.push(data); return data; };

  const { runMarketMakerCycle } = await import('../src/agents/market-maker.agent');
  return { seen, run: () => runMarketMakerCycle({ signal: new AbortController().signal }) };
}

test('runMarketMakerCycle skips before createMarketFromProposal, pinJson and any chain call', async () => {
  const { seen, run } = await cycleHarness({ maxTradeUsdc: 90 }); // below MIN_SEED
  const result = await run();
  assert.equal(result, null);
  assert.equal(seen.creates.length, 0, 'no DB row');
  assert.equal(seen.pins, 0, 'no IPFS pin');
  assert.equal(seen.chainCreates.length, 0, 'no chain call');
  assert.equal(seen.logs.length, 1);
  assert.equal(seen.logs[0].action, 'SEED_SKIPPED');
  assert.equal(seen.logs[0].data.reason, 'BELOW_MIN_SEED');
});

test('a treasury budget read failure fails closed', async () => {
  const { seen, run } = await cycleHarness({ budgetFails: true });
  assert.equal(await run(), null);
  assert.equal(seen.creates.length, 0);
  assert.equal(seen.pins, 0);
  assert.equal(seen.chainCreates.length, 0);
  assert.equal(seen.logs[0].action, 'SEED_SKIPPED');
  assert.equal(seen.logs[0].data.reason, 'INSUFFICIENT_CAPITAL');
});

test('the create path passes the decided seed and price to agentCreateMarket and stores seedPolicy', async () => {
  const { seen, run } = await cycleHarness();
  const result = await run();
  assert.equal(result?.onChainMarketId, '42');

  const decided = seen.updates.find((u) => u.seedPolicy)!.seedPolicy;
  const call = seen.chainCreates[0];
  assert.equal(call.seed_amount.toString(), decided.seedRaw, 'the chain call uses the decided seed');
  // The default 25 USDC LP-loss budget binds below the 300 USDC category base; far from the LLM's 50 000.
  assert.equal(decided.binding, 'LP_LOSS_BUDGET');
  assert.ok(call.seed_amount >= 100n * USDC && call.seed_amount < 300n * USDC);
  assert.equal(call.initial_yes_bps, decided.initialYesBps);

  // 0.7 shrunk for a 0.30-wide CI: w = 0.5, factor 0.75 → 0.65.
  assert.ok(Math.abs(decided.pAdj - 0.65) < 1e-9);
  assert.equal(call.initial_yes_bps, 6500);
  assert.ok(Math.abs(seen.creates[0].initialYesProb - 0.65) < 1e-9, 'initialYesProb stores the adjusted price');
  assert.equal(seen.creates[0].minimumLiquidity, Number(call.seed_amount) / 1e7, 'minimumLiquidity records the decided seed');
  assert.ok(decided.binding && decided.inputs && decided.expectedLpLossRaw !== undefined);

  const trace = seen.traces[0];
  assert.ok(Math.abs(trace.marketProbability - 0.65) < 1e-9, 'a real marketProbability, not 0.5');
  assert.equal(trace.seedPolicy.seedRaw, decided.seedRaw);
});
