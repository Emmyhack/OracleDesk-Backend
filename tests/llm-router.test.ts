import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

async function modules() {
  const { createRouter } = await import('../src/lib/llm/router');
  const { LlmError } = await import('../src/lib/llm/types');
  const { DEFAULT_POLICIES, loadPolicies } = await import('../src/lib/llm/policy');
  return { createRouter, LlmError, DEFAULT_POLICIES, loadPolicies };
}

function spec(provider: string, model = 'm', extra: any = {}) {
  return { provider, model, temperature: 0.2, maxTokens: 100, timeoutMs: 1000, retries: 0, ...extra } as any;
}

function fakeProvider(name: string, outcomes: any[], available = true) {
  let index = 0;
  const calls: any[] = [];
  return {
    name,
    calls,
    available: () => available,
    async complete(_spec: any, req: any) {
      calls.push({ spec: _spec, req });
      const next = outcomes[Math.min(index++, outcomes.length - 1)];
      if (next instanceof Error) throw next;
      return typeof next === 'string' ? { text: next } : next;
    },
  };
}

const request = (task: string) => ({ task, system: 's', user: 'u', mode: 'json' }) as any;

test('default policy routes market_generation to anthropic then gemini (#157)', async () => {
  const { DEFAULT_POLICIES } = await modules();
  assert.deepEqual(
    DEFAULT_POLICIES.market_generation.map((s: any) => `${s.provider}:${s.model}`),
    ['anthropic:claude-sonnet-4-6', 'gemini:gemini-2.0-flash'],
  );
  assert.equal(DEFAULT_POLICIES.hedge_conditions[0].maxTokens, 1024);
  assert.equal(DEFAULT_POLICIES.generic_text[0].temperature, 0.4);
});

test('missing provider key is skipped without counting a failure (#157)', async () => {
  const { createRouter } = await modules();
  const unavailable = fakeProvider('anthropic', [new Error('should not run')], false);
  const gemini = fakeProvider('gemini', ['{"ok":true}']);
  const router = createRouter({ generic_json: [spec('anthropic'), spec('gemini')] } as any, {
    anthropic: unavailable as any,
    gemini: gemini as any,
  });
  const result = await router.complete(request('generic_json'));
  assert.equal(result.provenance.provider, 'gemini');
  assert.equal(unavailable.calls.length, 0);
  assert.equal(router.health().anthropic.state, 'healthy');
});

test('short rate limits retry inline; long ones cool and fail over (#157)', async () => {
  const { createRouter, LlmError } = await modules();
  let now = 1_000;
  const sleeps: number[] = [];
  const anthropic = fakeProvider('anthropic', [new LlmError('rate_limited', 'anthropic', 'slow down', 1_000), '{"ok":true}']);
  const router = createRouter(
    { generic_json: [spec('anthropic', 'm', { retries: 1 })] } as any,
    { anthropic: anthropic as any },
    { clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } },
  );
  const result = await router.complete(request('generic_json'));
  assert.equal(anthropic.calls.length, 2);
  assert.deepEqual(sleeps, [1_000]);
  assert.equal(result.provenance.attempts[0].kind, 'rate_limited');

  now = 2_000;
  const slow = fakeProvider('anthropic', [new LlmError('rate_limited', 'anthropic', 'wait', 30_000)]);
  const gemini = fakeProvider('gemini', ['{"ok":true}']);
  const router2 = createRouter(
    { generic_json: [spec('anthropic'), spec('gemini')] } as any,
    { anthropic: slow as any, gemini: gemini as any },
    { clock: () => now, sleep: async (ms) => { now += ms; } },
  );
  const result2 = await router2.complete(request('generic_json'));
  assert.equal(result2.provenance.provider, 'gemini');
  assert.equal(router2.health().anthropic.state, 'cooling');
  assert.ok((router2.health().anthropic.until ?? 0) > now);
});

test('quota exhaustion opens the circuit for an hour (#157)', async () => {
  const { createRouter, LlmError } = await modules();
  let now = 5_000;
  const anthropic = fakeProvider('anthropic', [new LlmError('quota_exhausted', 'anthropic', 'quota')]);
  const gemini = fakeProvider('gemini', ['{"ok":true}']);
  const router = createRouter({ generic_json: [spec('anthropic'), spec('gemini')] } as any, {
    anthropic: anthropic as any,
    gemini: gemini as any,
  }, { clock: () => now });
  await router.complete(request('generic_json'));
  assert.equal(router.health().anthropic.state, 'open');
  assert.equal((router.health().anthropic.until ?? 0) - now, 60 * 60 * 1000);

  const skipped = await router.complete(request('generic_json'));
  assert.equal(skipped.provenance.provider, 'gemini');
  assert.equal(anthropic.calls.length, 1, 'open circuit is not called again');
});

test('three server errors cool a provider for 60s (#157)', async () => {
  const { createRouter, LlmError } = await modules();
  let now = 10_000;
  const anthropic = fakeProvider('anthropic', [new LlmError('server', 'anthropic', 'boom')]);
  const router = createRouter({ generic_json: [spec('anthropic')] } as any, { anthropic: anthropic as any }, { clock: () => now });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(router.complete(request('generic_json')));
  }
  assert.equal(router.health().anthropic.state, 'cooling');
  assert.equal((router.health().anthropic.until ?? 0) - now, 60_000);
  await assert.rejects(router.complete(request('generic_json')));
  assert.equal(anthropic.calls.length, 3, 'cooling provider is skipped');
});

test('JSON parse failure fails over to the next model (#157)', async () => {
  const { createRouter } = await modules();
  const anthropic = fakeProvider('anthropic', ['not json']);
  const gemini = fakeProvider('gemini', ['{"ok":true}']);
  const router = createRouter({ generic_json: [spec('anthropic'), spec('gemini')] } as any, {
    anthropic: anthropic as any,
    gemini: gemini as any,
  });
  const result = await router.complete(request('generic_json'));
  assert.equal(result.provenance.provider, 'gemini');
  assert.equal(result.provenance.attempts[0].kind, 'parse');
});

test('text mode is passed through without a JSON requirement (#157)', async () => {
  const { createRouter } = await modules();
  const anthropic = fakeProvider('anthropic', ['plain text']);
  const router = createRouter({ generic_text: [spec('anthropic')] } as any, { anthropic: anthropic as any });
  const result = await router.complete({ task: 'generic_text', system: 's', user: 'u', mode: 'text' } as any);
  assert.equal(result.text, 'plain text');
  assert.equal(anthropic.calls[0].req.mode, 'text');
});

test('auth errors fail over, and all-exhausted includes attempts (#157)', async () => {
  const { createRouter, LlmError } = await modules();
  const anthropic = fakeProvider('anthropic', [new LlmError('auth', 'anthropic', 'bad key')]);
  const gemini = fakeProvider('gemini', [new LlmError('server', 'gemini', 'down')]);
  const router = createRouter({ generic_json: [spec('anthropic'), spec('gemini')] } as any, {
    anthropic: anthropic as any,
    gemini: gemini as any,
  });
  await assert.rejects(
    router.complete(request('generic_json')),
    (err: any) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.attempts.length, 2);
      assert.equal(err.attempts[0].kind, 'auth');
      return true;
    },
  );
});

test('LLM_POLICY validation names the bad task (#157)', async () => {
  const { loadPolicies } = await modules();
  assert.throws(
    () => loadPolicies(JSON.stringify({ market_generation: [] })),
    /market_generation/,
  );
  assert.throws(
    () => loadPolicies('{not json'),
    /not valid JSON/,
  );
  const parsed = loadPolicies(JSON.stringify({
    market_generation: [{ provider: 'gemini', model: 'gemini-2.0-flash', temperature: 0, maxTokens: 10, timeoutMs: 1000 }],
  }));
  assert.equal(parsed.market_generation[0].provider, 'gemini');
});
