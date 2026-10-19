import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const anthropicReq = (user: string, extra: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-4-6', max_tokens: 1024, temperature: 0.2, system: 'You are a forecaster.',
  messages: [{ role: 'user', content: user }], ...extra,
});

test('fingerprints ignore timestamps, UUIDs, nonces, API keys and query-param order', async () => {
  const { fingerprint } = await import('./helpers/cassettes');
  const a = fingerprint('anthropic', anthropicReq(
    'Current date: 2026-10-18T12:00:00.000Z\nmarket 7d1f3c9a-5b2e-4d6f-8a0c-1e3b5d7f9a1c\n<untrusted_signals nonce="a1b2c3d4e5f6">',
  ));
  const b = fingerprint('anthropic', anthropicReq(
    'Current date: 2027-01-02T03:04:05Z\nmarket 0b9e1c7e-2f4a-4c1d-9e8b-3a5f7c9d1e2f\n<untrusted_signals nonce="ffffffffffff">',
  ));
  assert.equal(a, b);
  assert.notEqual(a, fingerprint('anthropic', anthropicReq('Current date: 2026-10-18T12:00:00.000Z\nanother market')));

  const http1 = fingerprint('http', { method: 'GET', url: 'https://newsapi.org/v2/everything', params: { q: 'fed', pageSize: 30, apiKey: 'k1' } });
  const http2 = fingerprint('http', { method: 'GET', url: 'https://newsapi.org/v2/everything', params: { apiKey: 'k2', pageSize: 30, q: 'fed' } });
  assert.equal(http1, http2, 'param order and the key do not matter');
  const inUrl = fingerprint('http', { method: 'GET', url: 'https://newsapi.org/v2/everything?pageSize=30&apiKey=k3&q=fed', params: {} });
  assert.equal(inUrl, http1, 'a query string in the URL is normalised the same way');
  assert.notEqual(http1, fingerprint('http', { method: 'GET', url: 'https://newsapi.org/v2/everything', params: { q: 'ecb', pageSize: 30 } }));

  const gem = (k: string) => fingerprint('gemini', { model: 'gemini-2.0-flash', systemInstruction: 's', generationConfig: { temperature: 0.1 }, prompt: 'p', headers: { 'x-goog-api-key': k } });
  assert.equal(gem('AIzaONE'), gem('AIzaTWO'));
});

test('equal fingerprints are served in recorded order', async () => {
  const { Cassette, fingerprint } = await import('./helpers/cassettes');
  const req = anthropicReq('same prompt');
  const fp = fingerprint('anthropic', req);
  const c = new Cassette('unit/dupes', 'replay', {
    version: 1,
    interactions: [
      { kind: 'anthropic', fingerprint: fp, request: req, response: { n: 1 }, recordedAt: '' },
      { kind: 'anthropic', fingerprint: fp, request: req, response: { n: 2 }, recordedAt: '' },
    ],
  });
  const live = async () => { throw new Error('replay must not go live'); };
  assert.deepEqual(await c.serve('anthropic', req, live), { n: 1 });
  assert.deepEqual(await c.serve('anthropic', req, live), { n: 2 });
  c.finish();
  await assert.rejects(c.serve('anthropic', req, live), (e: any) => e.name === 'CassetteMiss' && /no anthropic interactions left/.test(e.message));
});

test('a recorded error is replayed with its status', async () => {
  const { Cassette, fingerprint } = await import('./helpers/cassettes');
  const req = anthropicReq('overloaded');
  const c = new Cassette('unit/error', 'replay', {
    version: 1,
    interactions: [{ kind: 'anthropic', fingerprint: fingerprint('anthropic', req), request: req, error: { status: 529, name: 'APIError', message: 'Overloaded' }, recordedAt: '' }],
  });
  await assert.rejects(c.serve('anthropic', req, async () => null), (e: any) => e.status === 529 && e.message === 'Overloaded');
});

test('CassetteMiss shows the normalised request diffed against the closest recorded one', async () => {
  const { Cassette, CassetteMiss, fingerprint, normalise } = await import('./helpers/cassettes');
  const near = anthropicReq('line one\nQUESTION: Will the Fed cut in December?\nline three');
  const far = anthropicReq('something entirely different about football and the weather this weekend');
  const c = new Cassette('unit/miss', 'replay', {
    version: 1,
    interactions: [far, near].map((r) => ({ kind: 'anthropic' as const, fingerprint: fingerprint('anthropic', r), request: normalise('anthropic', r), response: {}, recordedAt: '' })),
  });
  const actual = anthropicReq('line one\nQUESTION: Will the Fed hike in December?\nline three');
  await assert.rejects(c.serve('anthropic', actual, async () => ({})), (e: any) => {
    assert.ok(e instanceof CassetteMiss);
    assert.match(e.message, /unit\/miss: unmatched anthropic request/);
    assert.match(e.message, /\+ .*hike in December/);
    assert.match(e.message, /- .*cut in December/);
    assert.ok(!/football/.test(e.message), 'diffed against the closest, not the first');
    return true;
  });
});

test('unused interactions fail the test at teardown', async () => {
  const { Cassette, fingerprint } = await import('./helpers/cassettes');
  const req = anthropicReq('never asked');
  const c = new Cassette('unit/unused', 'replay', {
    version: 1,
    interactions: [{ kind: 'anthropic', fingerprint: fingerprint('anthropic', req), request: req, response: {}, recordedAt: '' }],
  });
  assert.throws(() => c.finish(), /1 recorded interaction\(s\) were never requested \(#0 anthropic\)/);
});

test('recorded NewsAPI responses keep only the articles and text the prompt uses', async () => {
  const { trimResponse, NEWS_ARTICLES, NEWS_TEXT_CHARS } = await import('./helpers/cassettes');
  const long = 'x'.repeat(500);
  const res = { status: 'ok', articles: Array.from({ length: 30 }, (_, i) => ({ source: { name: 'S' }, title: long, description: long, content: long, url: `https://e.com/${i}`, publishedAt: 't' })) };
  const trimmed: any = trimResponse('http', { url: 'https://newsapi.org/v2/everything' }, res);
  assert.equal(trimmed.articles.length, NEWS_ARTICLES);
  assert.equal(trimmed.articles[0].title.length, NEWS_TEXT_CHARS);
  assert.ok(!('content' in trimmed.articles[0]));
});

test('modes: replay by default, record needs CASSETTE_RECORD=1, CI is replay only', async () => {
  const { cassetteMode } = await import('./helpers/cassettes');
  const saved = { mode: process.env.CASSETTE_MODE, rec: process.env.CASSETTE_RECORD, ci: process.env.CI };
  try {
    delete process.env.CASSETTE_MODE;
    delete process.env.CI;
    assert.equal(cassetteMode(), 'replay');
    process.env.CASSETTE_MODE = 'record';
    delete process.env.CASSETTE_RECORD;
    assert.throws(() => cassetteMode(), /CASSETTE_RECORD=1/);
    process.env.CASSETTE_RECORD = '1';
    assert.equal(cassetteMode(), 'record');
    process.env.CI = 'true';
    assert.throws(() => cassetteMode(), /replay mode only/);
  } finally {
    for (const [k, v] of [['CASSETTE_MODE', saved.mode], ['CASSETTE_RECORD', saved.rec], ['CI', saved.ci]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a fake key fed through every transport never reaches disk', async () => {
  const { useCassette, CASSETTE_DIR, CassetteSecretError } = await import('./helpers/cassettes');
  const llm = await import('../src/lib/llm');
  const ingestion = await import('../src/services/ingestion.service');
  const KEYS = {
    ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE',
    GEMINI_API_KEY: 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
    NEWSAPI_KEY: '0123456789abcdef0123456789abcdef',
    FRED_API_KEY: 'fedcba9876543210fedcba9876543210',
  };
  const saved = { ...process.env };
  Object.assign(process.env, KEYS, { CASSETTE_MODE: 'record', CASSETTE_RECORD: '1', CASSETTE_UPSTREAM: 'scripted' });
  delete process.env.CI;
  const name = `__tmp__/secret-${process.pid}`;
  const path = join(CASSETTE_DIR, `${name}.json`);
  try {
    // Echoing providers: the guard refuses to write.
    await assert.rejects(
      useCassette(name, async () => {
        const client = llm.getAnthropicClient()!;
        await client.messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] } as any);
      }, { upstream: { anthropic: async () => ({ content: [{ type: 'text', text: `leak ${KEYS.ANTHROPIC_API_KEY}` }] }) } }),
      (e: any) => e instanceof CassetteSecretError,
    );
    assert.equal(existsSync(path), false, 'nothing written');

    await assert.rejects(
      useCassette(name, async () => {
        const fetchNews = (await import('../src/services/ingestion.service')).fetchNewsSignals;
        const { setSecretsForTest, SECRET_NAMES } = await import('../src/config/secrets');
        setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, (KEYS as any)[n] ?? ''])) as any);
        const { MemorySignalStore, setSignalStore } = await import('../src/services/signal-store.service');
        const prev = setSignalStore(new MemorySignalStore());
        try { await fetchNews(); } finally { setSignalStore(prev); }
        // A credential-named field would be stripped anyway; a key inside free text is caught by value.
      }, { upstream: { http: async (_u, o: any) => ({ data: { articles: [], message: `quota for key ${o.params.apiKey} exceeded` } }) } }),
      (e: any) => e instanceof CassetteSecretError,
    );
    assert.equal(existsSync(path), false);

    // Keys only in requests (stripped by normalisation): written, and clean.
    await useCassette(name, async () => {
      const client = llm.getAnthropicClient()!;
      await client.messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }], authorization: KEYS.ANTHROPIC_API_KEY } as any);
      const { getGeminiModel } = await import('../src/lib/gemini');
      await getGeminiModel({ model: 'gemini-2.0-flash', systemInstruction: 's', generationConfig: { key: KEYS.GEMINI_API_KEY } as any }).generateContent('hi');
      const fetchFed = (await import('../src/services/ingestion.service')).fetchFedData;
      const { setSecretsForTest, SECRET_NAMES } = await import('../src/config/secrets');
      setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, (KEYS as any)[n] ?? ''])) as any);
      const { MemorySignalStore, setSignalStore } = await import('../src/services/signal-store.service');
      const prev = setSignalStore(new MemorySignalStore());
      try { await fetchFed(); } finally { setSignalStore(prev); }
    }, {
      upstream: {
        anthropic: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        gemini: async () => ({ text: 'ok' }),
        http: async () => ({ data: { observations: [{ date: '2026-09-01', value: '4.33' }] } }),
      },
    });
    const written = readFileSync(path, 'utf8');
    for (const k of Object.values(KEYS)) assert.ok(!written.includes(k), `${k.slice(0, 8)}… reached disk`);
    const file = JSON.parse(written);
    assert.deepEqual(file.interactions.map((i: any) => i.kind), ['anthropic', 'gemini', 'http', 'http', 'http', 'http']);
    assert.equal(file.synthetic, true);
  } finally {
    rmSync(join(CASSETTE_DIR, '__tmp__'), { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    const { setSecretsForTest, SECRET_NAMES } = await import('../src/config/secrets');
    setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, ''])) as any);
  }
});

test('scanForSecrets flags configured values and key-shaped strings', async () => {
  const { scanForSecrets } = await import('./helpers/cassettes');
  assert.deepEqual(scanForSecrets('{"text":"hello"}'), []);
  assert.ok(scanForSecrets('{"text":"sk-ant-api03-abcdefghijklmnop"}').length > 0);
  assert.ok(scanForSecrets('{"text":"AIzaSyAbcdefghijklmnopqrstuv"}').length > 0);
  assert.ok(scanForSecrets('{"api_key":"0123456789abcdef0123456789abcdef"}').length > 0);
  assert.ok(scanForSecrets('GET /x?apiKey=0123456789abcdef0123456789abcdef').length > 0);
  assert.ok(scanForSecrets('anything with mysecretvalue inside', ['mysecretvalue']).length > 0);
  // A 64-hex hash in an ordinary field is not a key.
  assert.deepEqual(scanForSecrets('{"fingerprint":"' + 'a'.repeat(64) + '"}'), []);
});
