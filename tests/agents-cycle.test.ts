import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import { installFakeAgentsEnv, NOW, USDC, type FakeAgentsEnv } from './helpers/fake-agents-env';
import { useCassette, type Cassette, type Upstream } from './helpers/cassettes';

setupTestEnv();

// End-to-end agent cycles (#72): real services, Prisma in memory, a fake chain
// and IPFS, and every LLM / data-source request served from a cassette in
// tests/cassettes/agents/. Nothing here reaches a network.
//
// Each scenario's `upstream` is used only to author a synthetic cassette
// (CASSETTE_MODE=record CASSETTE_RECORD=1 CASSETTE_UPSTREAM=scripted); replay
// never consults it. Assertions read expected values from the recording, so a
// live re-recording keeps them meaningful.

const NOTE = 'Synthetic: authored from the scripted upstream in tests/agents-cycle.test.ts. Re-record with live keys per CONTRIBUTING.md.';
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

// ─── Scripted data sources ────────────────────────────────────────────────────

const NEWS = {
  status: 'ok',
  totalResults: 6,
  articles: [
    { source: { id: null, name: 'Example Wire' }, title: 'Fed officials signal a rate cut at the December meeting', description: 'Two Federal Reserve governors said inflation is close enough to target to cut rates at the December meeting.', url: 'https://wire.example.com/fed-december-cut', publishedAt: iso(60) },
    { source: { id: null, name: 'Example Europe' }, title: 'ECB holds deposit rate as eurozone growth stalls', description: 'The European Central Bank left its deposit facility rate unchanged.', url: 'https://europe.example.com/ecb-holds', publishedAt: iso(120) },
    { source: { id: null, name: 'Example Politics' }, title: 'Senate schedules vote on the budget resolution', description: 'Leaders set a procedural vote for next week.', url: 'https://politics.example.com/senate-vote', publishedAt: iso(150) },
    { source: { id: null, name: 'Example Crypto' }, title: 'Bitcoin steadies after a volatile week', description: 'The largest cryptocurrency traded in a narrow range.', url: 'https://crypto.example.com/btc-steadies', publishedAt: iso(180) },
    { source: { id: null, name: 'Example Sport' }, title: 'Premier League leaders extend their unbeaten run', description: 'A late goal kept the streak alive.', url: 'https://sport.example.com/unbeaten', publishedAt: iso(200) },
    { source: { id: null, name: 'Example Arts' }, title: 'Box office weekend led by an animated sequel', description: 'The sequel opened above forecasts.', url: 'https://arts.example.com/box-office', publishedAt: iso(240) },
  ],
};
const FRED: Record<string, unknown> = {
  FEDFUNDS: { observations: [{ date: '2026-09-01', value: '4.33' }, { date: '2026-08-01', value: '4.33' }] },
  CPIAUCSL: { observations: [{ date: '2026-09-01', value: '321.465' }, { date: '2026-08-01', value: '320.580' }] },
  UNRATE: { observations: [{ date: '2026-09-01', value: '4.2' }, { date: '2026-08-01', value: '4.1' }] },
  T10Y2Y: { observations: [{ date: '2026-10-16', value: '0.52' }, { date: '2026-10-15', value: '0.50' }] },
};
const GDELT = {
  articles: [
    { url: 'https://news.example.org/central-bank-pause', title: 'Central bank signals pause after a year of hikes', seendate: '20261018T091500Z', domain: 'news.example.org' },
  ],
};

const http: Upstream['http'] = async (url, o) => {
  if (url.includes('newsapi.org')) return { data: NEWS };
  if (url.includes('stlouisfed.org')) return { data: FRED[String(o.params?.series_id)] };
  if (url.includes('gdeltproject.org')) return { data: GDELT };
  throw new Error(`unexpected ${url}`);
};

// ─── Scripted models ──────────────────────────────────────────────────────────

const DECEMBER_CLOSE = Math.floor(Date.parse('2026-12-09T20:30:00Z') / 1000);

/** The citable id the prompt gave the Fed headline (n1…), read from the rendered block. */
function fedSignalId(prompt: string): string {
  const line = prompt.split('\n').find((l) => l.includes('rate cut at the December meeting'));
  const id = line && /"id":"(n\d+)"/.exec(line)?.[1];
  if (!id) throw new Error('scripted model: the Fed headline is not in the prompt');
  return id;
}

function proposal(prompt: string, over: Record<string, unknown> = {}) {
  return {
    market_question: 'Will the Fed cut rates at its December meeting?',
    initial_yes_probability: 0.42,
    resolution_oracle: 'FRED',
    expiry_timestamp: DECEMBER_CLOSE,
    settlement_currency: 'USDC',
    minimum_liquidity_usdc: 250,
    category: 'FED',
    confidence_interval: { lower: 0.3, upper: 0.55 },
    reasoning: 'Officials signalled a December cut; inflation is near target but data could still delay it.',
    grounding_signal_ids: [fedSignalId(prompt)],
    ...over,
  };
}

const HEDGE = {
  hedge_conditions: ['Close if core PCE re-accelerates before the meeting', 'Close if two officials push back on a December cut'],
  reasoning_summary: 'The cut is signalled but data-dependent; size small until the November data.',
  key_signals: ['s1'],
  risk_factors: ['hot inflation print'],
};

const userText = (req: any) => (req.messages ?? []).map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
const toolUse = (name: string, input: unknown) => ({
  id: 'msg_scripted', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
  content: [{ type: 'tool_use', id: 'toolu_scripted', name, input }], stop_reason: 'tool_use',
  usage: { input_tokens: 1200, output_tokens: 180 },
});
const overloaded = () => Object.assign(new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { status: 529, name: 'APIError' });

function anthropic(opts: { failWith529?: boolean; proposalOver?: Record<string, unknown> } = {}): Upstream['anthropic'] {
  return async (req) => {
    if (opts.failWith529) throw overloaded();
    const tool = req.tools?.[0]?.name;
    if (tool === 'submit_market_proposal') return toolUse(tool, proposal(userText(req), opts.proposalOver));
    if (tool === 'submit_trade_reasoning') return toolUse(tool, HEDGE);
    throw new Error(`scripted model: unexpected tool ${tool}`);
  };
}

function gemini(opts: { proposalOver?: Record<string, unknown> } = {}): Upstream['gemini'] {
  return async (req) => {
    const prompt = typeof req.prompt === 'string'
      ? req.prompt
      : (req.prompt as any[]).flatMap((c) => c.parts.map((p: any) => p.text)).join('\n');
    if (req.systemInstruction.includes('prediction market creator')) return { text: JSON.stringify(proposal(prompt, opts.proposalOver)), usage: { promptTokenCount: 1100, candidatesTokenCount: 170 } };
    if (req.systemInstruction.includes('risk manager')) return { text: JSON.stringify(HEDGE), usage: { promptTokenCount: 400, candidatesTokenCount: 90 } };
    throw new Error('scripted model: unexpected Gemini prompt');
  };
}

// ─── Harness ──────────────────────────────────────────────────────────────────

async function scenario<T>(
  name: string,
  upstream: Upstream,
  fn: (env: FakeAgentsEnv, cassette: Cassette) => Promise<T>,
  setup?: (env: FakeAgentsEnv) => void,
  chain?: Parameters<typeof installFakeAgentsEnv>[0],
): Promise<T> {
  const env = await installFakeAgentsEnv(chain);
  setup?.(env);
  try {
    return await useCassette(`agents/${name}`, async (cassette) => {
      const out = await fn(env, cassette);
      await env.settle();
      return out;
    }, { upstream, note: NOTE });
  } finally {
    await env.restore();
  }
}

const kinds = (c: Cassette) => c.calls.map((x) => x.kind);
const hosts = (c: Cassette) => c.calls.filter((x) => x.kind === 'http').map((x) => new URL((x.request as any).url).hostname).sort();
const SOURCE_HOSTS = ['api.gdeltproject.org', 'api.stlouisfed.org', 'api.stlouisfed.org', 'api.stlouisfed.org', 'api.stlouisfed.org', 'newsapi.org'];
const logs = (env: FakeAgentsEnv) => env.db.rows('agentLog').map((l) => l.action);
const recordedProposal = (c: Cassette) => c.responseOf('anthropic', 0)?.content?.find((b: any) => b.type === 'tool_use')?.input;

// ─── Market maker ─────────────────────────────────────────────────────────────

test('market maker: news+fred signals → anthropic proposal → dry-run create → trace pinned', async () => {
  const { runMarketMakerCycle } = await import('../src/agents/market-maker.agent');
  const started = Date.now();
  await scenario('market-maker-happy', { http, anthropic: anthropic() }, async (env, cassette) => {
    const result = await runMarketMakerCycle({ priority: 'cron' });
    await env.settle();

    // Transport calls: the three sources (in parallel, so compared as a set), then proposal and hedge conditions.
    assert.deepEqual(kinds(cassette), ['http', 'http', 'http', 'http', 'http', 'http', 'anthropic', 'anthropic']);
    assert.deepEqual(hosts(cassette), SOURCE_HOSTS);
    assert.deepEqual(cassette.calls.filter((c) => c.kind === 'anthropic').map((c) => (c.request as any).tools[0].name), ['submit_market_proposal', 'submit_trade_reasoning']);

    // DB: one PENDING market from the recorded proposal, with its provenance and seed policy.
    const recorded = recordedProposal(cassette);
    const markets = env.db.rows('market');
    assert.equal(markets.length, 1);
    const [market] = markets;
    assert.equal(result?.marketId, market.id);
    assert.equal(result?.onChainMarketId, null, 'dry-run: not on-chain');
    assert.equal(market.question, recorded.market_question);
    assert.equal(market.status, 'PENDING');
    assert.equal(market.generationProvenance.provider, 'anthropic');
    assert.ok(market.seedPolicy, 'seed policy recorded');

    // Chain: one simulated agent_create_market pointing at the pinned question document.
    const creates = env.chain.filter((c) => c.fn === 'agentCreateMarket');
    assert.equal(creates.length, 1);
    const args = creates[0].args[0] as any;
    assert.ok(env.ipfs.has(args.meta_uri.replace('ipfs://', '')), 'question document pinned');
    assert.equal(args.close_time, BigInt(recorded.expiry_timestamp));

    // Trace: cites the grounding signal by store id, pinned, waiting for the market to land.
    const [trace] = env.db.rows('reasoningTrace');
    assert.equal(trace.marketId, market.id);
    assert.equal(trace.sourcesUsed.length, 1);
    assert.match(trace.sourcesUsed[0].signalId, /^sig-/);
    assert.equal(trace.sourcesUsed[0].url, 'https://wire.example.com/fed-december-cut');
    assert.deepEqual(trace.provenance.llm.map((e: any) => e.promptId), ['market-proposal', 'hedge-conditions']);
    assert.ok(trace.ipfsCid && env.ipfs.has(trace.ipfsCid), 'trace pinned');
    const [publication] = env.db.rows('tracePublication');
    assert.equal(publication.status, 'AWAITING_MARKET');
    assert.ok(!env.chain.some((c) => c.fn === 'publishTrace'));

    assert.deepEqual(logs(env).filter((a) => a !== 'MARKET_CREATED'), ['GENERATE_QUESTION_LLM', 'DEDUP_CHECK']);
    assert.ok(env.signals.rows.size > 0 && env.signals.fetches.length === 3, 'the store started empty and was filled');
  });
  assert.ok(Date.now() - started < 10_000, 'offline and fast');
});

test('market maker: anthropic 529 → gemini fallback served from cassette', async () => {
  const { runMarketMakerCycle } = await import('../src/agents/market-maker.agent');
  await scenario('market-maker-gemini-fallback', { http, anthropic: anthropic({ failWith529: true }), gemini: gemini() }, async (env, cassette) => {
    const result = await runMarketMakerCycle({ priority: 'cron' });
    assert.ok(result, JSON.stringify(env.db.rows('agentLog').map((l) => [l.action, l.data])));
    assert.deepEqual(kinds(cassette).filter((k) => k !== 'http'), ['anthropic', 'gemini', 'anthropic', 'gemini']);
    assert.deepEqual(hosts(cassette), SOURCE_HOSTS);
    assert.equal(cassette.interactions.find((i) => i.kind === 'anthropic')?.error?.status, 529);

    const [market] = env.db.rows('market');
    assert.equal(market.generationProvenance.provider, 'gemini');
    assert.deepEqual(
      { provider: market.generationProvenance.fallbackFrom.provider, errorClass: market.generationProvenance.fallbackFrom.errorClass },
      { provider: 'anthropic', errorClass: 'server_error' },
    );
    const [trace] = env.db.rows('reasoningTrace');
    assert.deepEqual(trace.provenance.llm.map((e: any) => e.provider), ['gemini', 'gemini']);
  });
});

test('market maker: duplicate proposal is skipped and no market row is created', async () => {
  const { runMarketMakerCycle } = await import('../src/agents/market-maker.agent');
  await scenario('market-maker-duplicate', { http, anthropic: anthropic() }, async (env, cassette) => {
    assert.equal(await runMarketMakerCycle({ priority: 'cron' }), null);
    assert.deepEqual(kinds(cassette).filter((k) => k !== 'http'), ['anthropic'], 'no hedge call: nothing to trace');
    // The existing market was in the prompt, in createdAt order.
    assert.match((cassette.calls.find((c) => c.kind === 'anthropic')!.request as any).messages[0].content, /ALREADY EXISTING MARKETS[\s\S]*Fed cut rates at its December meeting/);
    assert.deepEqual(env.db.rows('market').map((m) => m.id), ['existing-1'], 'no new row');
    assert.equal(env.db.rows('reasoningTrace').length, 0);
    assert.ok(!env.chain.some((c) => c.fn === 'agentCreateMarket'));
    const skipped = env.db.rows('agentLog').find((l) => l.action === 'DUPLICATE_SKIPPED');
    assert.equal(skipped?.marketId, 'existing-1');
  }, (env) => {
    env.db.insert('market', {
      id: 'existing-1', question: 'Will the Fed cut rates at its December meeting?', category: 'FED', status: 'ACTIVE',
      initialYesProb: 0.4, confidenceInterval: { lower: 0.3, upper: 0.5 }, expiryTimestamp: new Date(DECEMBER_CLOSE * 1000), createdAt: new Date(NOW.getTime() - 86_400_000),
    });
  });
});

test('market maker: invalid confidence interval from LLM returns null and logs', async () => {
  const { runMarketMakerCycle } = await import('../src/agents/market-maker.agent');
  const bad = { initial_yes_probability: 0.42, confidence_interval: { lower: 0.5, upper: 0.7 } };
  await scenario('market-maker-invalid-ci', { http, anthropic: anthropic({ proposalOver: bad }), gemini: gemini({ proposalOver: bad }) }, async (env, cassette) => {
    assert.equal(await runMarketMakerCycle({ priority: 'cron' }), null);
    // One repair round per provider, then the structured call gives up.
    assert.deepEqual(kinds(cassette).filter((k) => k !== 'http'), ['anthropic', 'anthropic', 'gemini', 'gemini'], JSON.stringify(env.db.rows('agentLog').map((l) => [l.action, l.data])));
    const repair = cassette.calls.filter((c) => c.kind === 'anthropic')[1].request as any;
    assert.match(JSON.stringify(repair.messages), /confidence_interval must satisfy/);
    assert.equal(env.db.rows('market').length, 0);
    const fail = env.db.rows('agentLog').find((l) => l.action === 'GENERATE_QUESTION_LLM_FAIL');
    assert.equal(fail?.data.code, 'LLM_STRUCTURED_OUTPUT_FAILED');
    assert.ok(!env.chain.some((c) => c.fn === 'agentCreateMarket'));
  });
});

// ─── Trader ───────────────────────────────────────────────────────────────────

test('trader: no ACTIVE markets → cycle completes without LLM calls', async () => {
  const { runTraderCycle } = await import('../src/agents/trader.agent');
  await scenario('trader-no-markets', { http }, async (env, cassette) => {
    await runTraderCycle();
    assert.deepEqual(kinds(cassette), ['http', 'http', 'http', 'http', 'http', 'http'], 'signals only, no LLM');
    assert.deepEqual(hosts(cassette), SOURCE_HOSTS);
    assert.ok(!env.chain.some((c) => c.fn === 'agentBuy' || c.fn === 'agentSell'));
    assert.deepEqual(env.chain.filter((c) => c.fn.startsWith('treasury')).map((c) => c.fn).sort(), ['treasuryAvailableCapital', 'treasuryDailyUsage', 'treasuryRiskConfig']);
    assert.equal(env.db.rows('trade').length, 0);
    assert.ok(!logs(env).includes('CYCLE_FAILED'));
  });
});

test('trader: open position past stop-loss is closed with STOP_LOSS', async () => {
  const { runTraderCycle } = await import('../src/agents/trader.agent');
  const { seedReserves, calcSell } = await import('../src/generated/fpmm');
  // YES bought at 0.50 for 100 USDC (≈190 shares); the pool now prices YES at 0.30.
  const pool = seedReserves(1_000n * USDC, 3_000n);
  const onChain = { reserve_yes: pool.reserveYes, reserve_no: pool.reserveNo, fee_bps: 100, status: { tag: 'Open', values: undefined } };
  const shares = 190n * USDC;
  await scenario('trader-stop-loss', { http }, async (env, cassette) => {
    await runTraderCycle();
    assert.deepEqual(kinds(cassette), ['http', 'http', 'http', 'http', 'http', 'http']);

    const position = env.db.table('position').get('pos-1')!;
    assert.equal(position.status, 'STOP_LOSS');
    assert.equal(position.closeReason, 'STOP_LOSS');
    assert.ok(position.closedAt);
    assert.ok(BigInt(position.realisedPnlRaw) < 0n, 'closed at a loss');
    const [exit] = env.db.rows('positionExit');
    assert.equal(exit.status, 'CONFIRMED');
    assert.equal(exit.reason, 'STOP_LOSS');
    const sells = env.chain.filter((c) => c.fn === 'agentSell');
    assert.equal(sells.length, 1);
    assert.deepEqual((sells[0].args[0] as any).outcome, { tag: 'Yes', values: undefined });
    assert.ok(logs(env).includes('POSITION_CLOSED'));
    assert.ok(!env.chain.some((c) => c.fn === 'agentBuy'));
  }, (env) => {
    env.db.insert('market', {
      id: 'mkt-1', question: 'Will the Fed cut rates at its December meeting?', category: 'FED', status: 'ACTIVE', onChainMarketId: 7n,
      initialYesProb: 0.5, currentYesProb: 0.5, totalLiquidity: 1_000, confidenceInterval: { lower: 0.4, upper: 0.6 },
      expiryTimestamp: new Date(NOW.getTime() + 30 * 86_400_000),
    });
    env.db.insert('trade', { id: 'trd-1', marketId: 'mkt-1', direction: 'YES', status: 'EXECUTED', amount: 100, price: 0.5, edgeDetected: 0.1, kellyFraction: 0.01 });
    env.db.insert('position', {
      id: 'pos-1', marketId: 'mkt-1', tradeId: 'trd-1', direction: 'YES', status: 'OPEN', entryPrice: 0.5, currentPrice: 0.5, size: 100, pnl: 0,
      sharesRaw: shares.toString(), costBasisRaw: (100n * USDC).toString(), realisedPnlRaw: '0', realisedCollateralRaw: '0',
    });
  }, {
    chain: {
      getOnChainMarket: async () => onChain as any,
      getPosition: async () => ({ yes: shares, no: 0n }) as any,
      quoteSell: async (_id: bigint, _o: unknown, collateralOut: bigint) => calcSell(pool.reserveYes, pool.reserveNo, collateralOut, 100n).sharesIn,
      // The fake chain confirms the sale: a live result closes the position.
      agentSell: (async (args: any) => ({ mode: 'live', method: 'agent_sell', value: args.max_shares_in, txHash: 'cd'.repeat(32) })) as any,
    },
  });
});
