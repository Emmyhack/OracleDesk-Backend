import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

// Synthetic provider responses shaped like the real APIs (#73).
const FIXTURES = join(__dirname, '..', '..', 'tests', 'fixtures', 'signals');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const NEWS = fixture('newsapi-everything.json');
const FRED = fixture('fred-observations.json');
const GDELT = fixture('gdelt-artlist.json');

const NOW = new Date('2026-10-18T12:00:00Z');
const NEWS_KEY = 'newsapi-test-key-7d1f3c9a5b2e4d6f8a0c1e3b5d7f9a1c';
const FRED_KEY = 'fredtestkey0123456789abcdef012345';

interface Harness {
  store: import('../src/services/signal-store.service').MemorySignalStore;
  clock: import('../src/lib/clock').FakeClock;
  requests: Array<{ url: string; params: Record<string, unknown> }>;
  restore(): void;
}

/** Memory store, fake clock and an HTTP stub answering from the fixtures. */
async function harness(opts: { keys?: boolean; respond?: (url: string, params: any) => any } = {}): Promise<Harness> {
  const { MemorySignalStore, setSignalStore } = await import('../src/services/signal-store.service');
  const { FakeClock, setClock } = await import('../src/lib/clock');
  const { setSignalHttp } = await import('../src/services/ingestion.service');
  const { setSecretsForTest, SECRET_NAMES } = await import('../src/config/secrets');

  const store = new MemorySignalStore();
  const clock = new FakeClock(NOW);
  const requests: Harness['requests'] = [];
  const prevStore = setSignalStore(store);
  const prevClock = setClock(clock);
  const respond = opts.respond ?? ((url: string, params: any) => {
    if (url.includes('newsapi')) return NEWS;
    if (url.includes('stlouisfed')) return FRED[params.series_id];
    if (url.includes('gdelt')) return GDELT;
    throw new Error(`unexpected ${url}`);
  });
  const prevHttp = setSignalHttp({
    async get(url, o) {
      requests.push({ url, params: { ...(o.params ?? {}) } });
      return { data: structuredClone(respond(url, o.params ?? {})) };
    },
  });
  const keys = opts.keys ?? true;
  setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [
    n, keys && n === 'NEWSAPI_KEY' ? NEWS_KEY : keys && n === 'FRED_API_KEY' ? FRED_KEY : '',
  ])) as any);
  return {
    store,
    clock,
    requests,
    restore() {
      setSignalStore(prevStore);
      setClock(prevClock);
      setSignalHttp(prevHttp);
      setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, ''])) as any);
    },
  };
}

test('canonicalUrl strips tracking params and normalises host', async () => {
  const { canonicalUrl } = await import('../src/services/signal-normalize');
  assert.equal(
    canonicalUrl('HTTPS://WWW.Reuters.com/markets/us/fed/?utm_source=x&utm_medium=y&b=2&fbclid=z&a=1&gclid=q&ref=home#top'),
    'https://reuters.com/markets/us/fed?a=1&b=2',
  );
  assert.equal(canonicalUrl('https://example.com/'), 'https://example.com');
  assert.equal(canonicalUrl('https://example.com/a/?ref=x'), 'https://example.com/a');
  assert.equal(canonicalUrl('ftp://example.com/a'), null);
  assert.equal(canonicalUrl(null), null);
  assert.equal(canonicalUrl('not a url'), null);
});

test('same article fetched twice increments seenCount, not rows', async () => {
  const h = await harness();
  try {
    const { fetchNewsSignals } = await import('../src/services/ingestion.service');
    await fetchNewsSignals();
    const rowsAfterFirst = h.store.rows.size;
    h.clock.advance(60_000);
    await fetchNewsSignals();
    assert.equal(h.store.rows.size, rowsAfterFirst, 'no new rows on the second fetch');
    const reuters = [...h.store.rows.values()].find((r) => r.url?.includes('reuters.com'))!;
    assert.equal(reuters.seenCount, 2);
    assert.equal(reuters.firstSeenAt.toISOString(), NOW.toISOString());
    assert.equal(reuters.lastSeenAt.toISOString(), new Date(NOW.getTime() + 60_000).toISOString());
    assert.equal(reuters.url, 'https://reuters.com/markets/us/fed-holds-rates-2026-10-14');
    assert.equal(reuters.publisher, 'Reuters');
  } finally {
    h.restore();
  }
});

test('NewsAPI [Removed] placeholders are dropped and counted as rejected', async () => {
  const h = await harness();
  try {
    const { fetchNewsSignals } = await import('../src/services/ingestion.service');
    const news = await fetchNewsSignals();
    assert.equal(news.length, 6);
    assert.ok(![...h.store.rows.values()].some((r) => r.title === '[Removed]'));
    const fetch = h.store.fetches.find((f) => f.source === 'NEWSAPI')!;
    assert.equal(fetch.status, 'ok');
    assert.equal(fetch.itemCount, 6);
    assert.equal(fetch.rejectedCount, 1);
    assert.ok(fetch.rawPayloadId && h.store.rawPayloads.has(fetch.rawPayloadId));
  } finally {
    h.restore();
  }
});

test('syndicated copies on three domains share one clusterId', async () => {
  const h = await harness();
  try {
    const { fetchNewsSignals } = await import('../src/services/ingestion.service');
    await fetchNewsSignals();
    const fed = [...h.store.rows.values()].filter((r) => r.title.startsWith('Federal Reserve holds rates'));
    assert.equal(fed.length, 3, 'three rows: different URLs are different identities');
    assert.deepEqual(new Set(fed.map((r) => new URL(r.url!).hostname)), new Set(['reuters.com', 'finance.yahoo.com', 'marketwatch.com']));
    const clusters = new Set(fed.map((r) => r.clusterId));
    assert.equal(clusters.size, 1);
    assert.ok(fed.some((r) => r.id === [...clusters][0]), 'the cluster id is one of its members');
  } finally {
    h.restore();
  }
});

test('templated but different headlines do not cluster', async () => {
  const h = await harness();
  try {
    const { fetchNewsSignals } = await import('../src/services/ingestion.service');
    const { hammingDistance, isNearDuplicate } = await import('../src/services/signal-normalize');
    await fetchNewsSignals();
    const [a, b] = [...h.store.rows.values()].filter((r) => r.title.startsWith('Stocks rise as'));
    assert.ok(a && b);
    assert.notEqual(a.clusterId, b.clusterId);
    assert.equal(isNearDuplicate(a, b), false);
    assert.ok(hammingDistance(a.simhash!, b.simhash!) > 3);
  } finally {
    h.restore();
  }
});

test('a story re-fetched hours later joins the existing (oldest) cluster', async () => {
  const later = { articles: [{ ...NEWS.articles[0], url: 'https://wire.example.net/fed-holds-rates', source: { name: 'Example Wire' } }] };
  let call = 0;
  const h = await harness({ respond: () => (call++ === 0 ? NEWS : later) });
  try {
    const { fetchNewsSignals } = await import('../src/services/ingestion.service');
    await fetchNewsSignals();
    const before = [...h.store.rows.values()].find((r) => r.url?.includes('reuters.com'))!;
    h.clock.advance(6 * 3_600_000);
    await fetchNewsSignals();
    const wire = [...h.store.rows.values()].find((r) => r.url?.includes('wire.example.net'))!;
    assert.equal(wire.clusterId, before.clusterId);
  } finally {
    h.restore();
  }
});

test('GDELT seendate parses to the right UTC instant; malformed dates are rejected', async () => {
  const { parseGdeltDate } = await import('../src/services/signal-normalize');
  assert.equal(parseGdeltDate('20261018T091500Z')?.toISOString(), '2026-10-18T09:15:00.000Z');
  assert.equal(parseGdeltDate('2026-10-18 07:30'), null);
  assert.equal(parseGdeltDate('20261318T091500Z'), null, 'month 13');
  assert.equal(parseGdeltDate(undefined), null);

  const h = await harness();
  try {
    const { fetchMacroEvents } = await import('../src/services/ingestion.service');
    const macro = await fetchMacroEvents();
    assert.equal(macro.length, 2);
    const row = [...h.store.rows.values()].find((r) => r.title.startsWith('Central bank'))!;
    assert.equal(row.publishedAt.toISOString(), '2026-10-18T09:15:00.000Z');
    assert.equal(row.url, 'https://example-news.com/world/central-bank-signals-pause');
    assert.equal(row.publisher, 'example-news.com');
    assert.equal(row.summary, null, 'the URL is kept in url, never in the text');
    assert.ok(![...h.store.rows.values()].some((r) => r.title.startsWith('Sanctions talks')), 'not stored as "now"');
    assert.equal(h.store.fetches.find((f) => f.source === 'GDELT')!.rejectedCount, 1);
  } finally {
    h.restore();
  }
});

test('GDELT deadline fires on the clock and is recorded as a timeout', async () => {
  let release!: () => void;
  const h = await harness({ respond: () => ({ articles: [] }) });
  const { setSignalHttp, fetchMacroEvents } = await import('../src/services/ingestion.service');
  const prevHttp = setSignalHttp({
    get: (_url, o) => new Promise((resolve, reject) => {
      release = () => resolve({ data: GDELT });
      o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
    }),
  });
  try {
    const pending = fetchMacroEvents();
    await new Promise((r) => setImmediate(r));
    h.clock.advance(8_000);
    assert.deepEqual(await pending, []);
    void release;
    const f = h.store.fetches.find((x) => x.source === 'GDELT')!;
    assert.equal(f.status, 'timeout');
  } finally {
    setSignalHttp(prevHttp);
    h.restore();
  }
});

test("FRED '.' observations are skipped and the api_key travels in params", async () => {
  const h = await harness();
  try {
    const { fetchFedData } = await import('../src/services/ingestion.service');
    const fed = await fetchFedData();
    const titles = fed.map((s) => s.title).sort();
    assert.deepEqual(titles, ['CPIAUCSL: 321.465', 'FEDFUNDS: 4.33', 'UNRATE: 4.2']);
    const rows = [...h.store.rows.values()];
    assert.ok(rows.every((r) => Number.isFinite(r.numericValue)), 'no NaN stored');
    assert.equal(rows.find((r) => r.externalId === 'UNRATE')!.publishedAt.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(h.store.fetches.find((f) => f.source === 'FRED')!.rejectedCount, 3);

    const fredReq = h.requests.filter((r) => r.url.includes('stlouisfed'));
    assert.equal(fredReq.length, 4);
    for (const r of fredReq) {
      assert.equal(r.url, 'https://api.stlouisfed.org/fred/series/observations', 'no key in the URL string');
      assert.equal(r.params.api_key, FRED_KEY);
      assert.deepEqual(Object.keys(r.params), ['series_id', 'file_type', 'sort_order', 'limit', 'api_key'], 'same query order as before');
    }
  } finally {
    h.restore();
  }
});

test('the same FRED observation fetched twice is one row', async () => {
  const h = await harness();
  try {
    const { fetchFedData } = await import('../src/services/ingestion.service');
    await fetchFedData();
    await fetchFedData();
    const fedfunds = [...h.store.rows.values()].filter((r) => r.externalId === 'FEDFUNDS');
    assert.equal(fedfunds.length, 1);
    assert.equal(fedfunds[0].seenCount, 2);
  } finally {
    h.restore();
  }
});

test('aggregateSignals returns one representative per cluster ordered by relevance', async () => {
  const h = await harness();
  try {
    const { aggregateSignals } = await import('../src/services/ingestion.service');
    const { SOURCE_WEIGHTS } = await import('../src/services/market-policy');
    const agg = await aggregateSignals();
    const fedStory = agg.news.filter((s) => s.title.startsWith('Federal Reserve holds rates'));
    assert.equal(fedStory.length, 1, 'syndicated copies collapse to one');
    assert.equal(fedStory[0].clusterSize, 3);
    assert.equal(agg.news.length, 4);
    assert.equal(agg.fed.length, 3);
    assert.equal(agg.macro.length, 2);
    assert.equal(agg.signalCount, 9);
    for (const group of [agg.news, agg.fed, agg.macro]) {
      for (let i = 1; i < group.length; i++) assert.ok(group[i - 1].relevanceScore >= group[i].relevanceScore);
    }
    // weight × decay × log2(1 + clusterSize): the 3-outlet story outranks
    // single-outlet news published around the same time.
    assert.equal(agg.news[0].title, fedStory[0].title);
    const ageH = (NOW.getTime() - new Date(fedStory[0].publishedAt).getTime()) / 3_600_000;
    const expected = SOURCE_WEIGHTS.NEWSAPI * Math.pow(0.5, ageH / 12) * Math.log2(4);
    assert.ok(Math.abs(fedStory[0].relevanceScore - expected) < 1e-3);
    assert.ok(agg.news.every((s) => typeof s.signalId === 'string' && s.url));

    // Within SIGNAL_REFRESH_MINUTES the store answers, no provider is called.
    const calls = h.requests.length;
    h.clock.advance(5 * 60_000);
    await aggregateSignals();
    assert.equal(h.requests.length, calls);
    h.clock.advance(15 * 60_000);
    await aggregateSignals();
    assert.ok(h.requests.length > calls, 'stale sources are re-fetched');
  } finally {
    h.restore();
  }
});

test('missing keys are recorded as skipped_no_key and nothing is fetched', async () => {
  const h = await harness({ keys: false });
  try {
    const { fetchNewsSignals } = await import('../src/services/ingestion.service');
    assert.deepEqual(await fetchNewsSignals(), []);
    assert.equal(h.requests.length, 0);
    assert.equal(h.store.fetches[0].status, 'skipped_no_key');
  } finally {
    h.restore();
  }
});

test('classifyNewsCategory returns a confidence', async () => {
  const { classifyNewsCategory } = await import('../src/services/signal-normalize');
  assert.deepEqual(classifyNewsCategory('FOMC minutes: Federal Reserve split'), { category: 'FED', confidence: 1 });
  assert.deepEqual(classifyNewsCategory('Bitcoin rallies after election'), { category: 'ELECTION', confidence: 0.5 });
  assert.deepEqual(classifyNewsCategory('Quarterly GDP beats estimates'), { category: 'MACRO', confidence: 0.2 });
  const h = await harness();
  try {
    const { fetchNewsSignals } = await import('../src/services/ingestion.service');
    await fetchNewsSignals();
    const btc = [...h.store.rows.values()].find((r) => r.title.startsWith('Bitcoin'))!;
    assert.equal(btc.category, 'CRYPTO');
    assert.equal(btc.categoryConfidence, 1);
  } finally {
    h.restore();
  }
});

test('no API key appears in any stored row', async () => {
  // Providers that echo the request (and an error that quotes the URL) are the
  // ways a key could reach storage.
  const h = await harness({
    respond: (url, params) => {
      if (url.includes('stlouisfed') && params.series_id === 'T10Y2Y') {
        throw new Error(`GET ${url}?series_id=T10Y2Y&api_key=${params.api_key} failed with 500`);
      }
      if (url.includes('stlouisfed')) return { ...FRED[params.series_id], request: { ...params }, api_key: params.api_key };
      if (url.includes('newsapi')) return { ...NEWS, echo: { apiKey: params.apiKey, nested: [{ key: params.apiKey }] } };
      return GDELT;
    },
  });
  try {
    const { aggregateSignals } = await import('../src/services/ingestion.service');
    await aggregateSignals();
    const dump = JSON.stringify({
      rows: [...h.store.rows.values()],
      fetches: h.store.fetches,
      raw: [...h.store.rawPayloads.values()],
    }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    assert.ok(dump.length > 1000);
    assert.ok(!dump.includes(NEWS_KEY), 'NEWSAPI_KEY leaked');
    assert.ok(!dump.includes(FRED_KEY), 'FRED_API_KEY leaked');
  } finally {
    h.restore();
  }
});

test('trace sourcesUsed carries signalId/url and previewSources omits url', async () => {
  const h = await harness();
  const { prisma } = await import('../src/lib/prisma');
  const llm = await import('../src/lib/llm');
  const created: any[] = [];
  const origCreate = prisma.reasoningTrace.create;
  (prisma.reasoningTrace.create as any) = async ({ data }: any) => { created.push(data); return { id: 'trace-1', ...data }; };
  const prevCaller = llm.setLlmJsonCaller(async () => JSON.stringify({
    hedge_conditions: ['Close if the Fed signals another hike'],
    reasoning_summary: 'Rates are on hold and inflation is cooling.',
    key_signals: ['n1'],
    risk_factors: ['surprise CPI print'],
  }));
  try {
    const { aggregateSignals } = await import('../src/services/ingestion.service');
    const { evidenceFromSignals, generateReasoningTrace } = await import('../src/services/reasoning.service');
    const agg = await aggregateSignals();
    const sources = evidenceFromSignals(agg.news.slice(0, 3));
    const { tracePayload } = await generateReasoningTrace({
      marketId: 'm1', agentType: 'MARKET_MAKER', decisionType: 'MARKET_CREATION',
      sourcesUsed: sources, probabilityEstimate: 0.4, marketProbability: 0.4, edge: 0,
      confidenceInterval: { lower: 0.3, upper: 0.5 },
    });
    const pinned = (tracePayload as any).sourcesUsed as any[];
    assert.equal(pinned.length, 3);
    for (const s of pinned) {
      assert.match(s.signalId, /^sig-/);
      assert.match(s.url, /^https:\/\//);
      assert.ok('publisher' in s && s.publishedAt);
      assert.equal(s.weight, agg.news.find((n) => n.signalId === s.signalId)!.relevanceScore);
    }
    assert.equal((tracePayload as any).timestamp, NOW.toISOString(), 'trace time comes from the clock');
    const preview = created[0].previewSources as any[];
    assert.equal(preview.length, 2);
    for (const p of preview) assert.deepEqual(Object.keys(p).sort(), ['publisher', 'signal', 'source']);

    // A pre-#73 trace (no signalId) still parses through the same code.
    const legacy = await generateReasoningTrace({
      marketId: 'm1', agentType: 'TRADER', decisionType: 'OPEN_POSITION',
      sourcesUsed: [{ source: 'NEWSAPI', weight: 0.7, signal: 'Old headline' }],
      probabilityEstimate: 0.5, marketProbability: 0.4, edge: 0.1, confidenceInterval: { lower: 0.4, upper: 0.6 },
    });
    assert.deepEqual((legacy.tracePayload as any).sourcesUsed, [{ source: 'NEWSAPI', weight: 0.7, signal: 'Old headline' }]);
  } finally {
    (prisma.reasoningTrace.create as any) = origCreate;
    llm.setLlmJsonCaller(prevCaller);
    h.restore();
  }
});

test('retention keeps trace-referenced signals', async () => {
  const h = await harness();
  try {
    const { fetchNewsSignals } = await import('../src/services/ingestion.service');
    const { purgeSignalStore } = await import('../src/services/signal-store.service');
    await fetchNewsSignals();
    const cited = [...h.store.rows.values()][0];
    h.store.citedSignalIds.add(cited.id);
    const later = new Date(NOW.getTime() + 31 * 86_400_000);
    const result = await purgeSignalStore(later, h.store);
    assert.equal(result.signals, 5);
    assert.deepEqual([...h.store.rows.keys()], [cited.id]);
    assert.equal(result.rawPayloads, 1);
    assert.equal(result.fetches, 1);
  } finally {
    h.restore();
  }
});

test('prisma store: one ON CONFLICT statement per 100 rows, and purge never deletes cited signals', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { Prisma } = await import('@prisma/client');
  const { prismaSignalStore } = await import('../src/services/signal-store.service');
  const queries: string[] = [];
  const execs: string[] = [];
  const orig = { q: prisma.$queryRaw, e: prisma.$executeRaw, raw: prisma.signalRawPayload.deleteMany, f: prisma.signalFetch.deleteMany };
  // Tagged-template calls: rebuild the Prisma.Sql to read its text and bound values.
  (prisma as any).$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    queries.push(sql.sql);
    const keys = sql.values.filter((v): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v));
    return keys.map((k) => ({ id: `id-${k.slice(0, 6)}`, dedupKey: k, clusterId: null, inserted: true }));
  };
  (prisma as any).$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    execs.push(Prisma.sql(strings, ...values).sql);
    return 0;
  };
  (prisma.signalRawPayload.deleteMany as any) = async () => ({ count: 0 });
  (prisma.signalFetch.deleteMany as any) = async () => ({ count: 0 });
  try {
    const { sha256Hex } = await import('../src/utils/hash.util');
    const rows = Array.from({ length: 250 }, (_, i) => ({
      source: 'NEWSAPI', dedupKey: sha256Hex(`u${i}`), externalId: null, url: `https://e.com/${i}`, publisher: null,
      title: `t${i}`, summary: null, publishedAt: NOW, category: 'MACRO', categoryConfidence: 0.2, numericValue: null, simhash: 1n,
    }));
    const out = await prismaSignalStore.upsert([...rows, rows[0]], NOW);
    assert.equal(queries.length, 3, '250 unique rows → 3 batched statements');
    assert.equal(out.length, 250);
    assert.match(queries[0], /ON CONFLICT \("dedupKey"\) DO UPDATE SET/);
    assert.match(queries[0], /"seenCount"\s+=\s+"signals"\."seenCount" \+ 1/);

    await prismaSignalStore.purge({ rawBefore: NOW, fetchesBefore: NOW, signalsBefore: NOW });
    assert.match(execs[0], /NOT EXISTS[\s\S]*"sourcesUsed" @> jsonb_build_array\(jsonb_build_object\('signalId', s\."id"\)\)/);
    assert.match(execs[0], /LIMIT/);
  } finally {
    (prisma as any).$queryRaw = orig.q;
    (prisma as any).$executeRaw = orig.e;
    (prisma.signalRawPayload.deleteMany as any) = orig.raw;
    (prisma.signalFetch.deleteMany as any) = orig.f;
  }
});
