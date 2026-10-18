/**
 * Shared LLM guards (#71). One table of scenarios runs against the JS reference
 * store (fake clock) and, when a Redis is reachable (TEST_REDIS_URL / REDIS_URL;
 * CI provides redis:7), against the real Lua scripts. Several "processes" are
 * several store objects sharing one backend. No LLM API is called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { setupTestEnv } from './helpers/env';
import type { AcquireParams, LlmGuardStore, RecordParams } from '../src/lib/llm-budget-store';

process.env.ANTHROPIC_API_KEY = '';
process.env.GEMINI_API_KEY = '';
setupTestEnv();

// ── Rigs ─────────────────────────────────────────────────────────────────────
interface Rig {
  name: string;
  /** A new "process": its own store object over the shared backend. */
  process(): LlmGuardStore;
  /** Moves time forward (fake clock) or really sleeps (Redis). */
  advance(ms: number): Promise<void>;
  /** Clears this rig's state. */
  done(): Promise<void>;
  redis?: Redis;
}

async function memoryRig(): Promise<Rig> {
  const { MemoryGuardStore } = await import('../src/lib/llm-budget-store');
  let now = Date.UTC(2026, 9, 18, 10, 0, 0);
  const shared = new MemoryGuardStore(() => now);
  return {
    name: 'memory',
    process: () => shared,
    advance: async (ms) => { now += ms; },
    done: async () => undefined,
  };
}

async function redisRig(url: string): Promise<Rig | null> {
  const { RedisGuardStore } = await import('../src/lib/llm-budget-store');
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 800 });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.ping();
  } catch {
    redis.disconnect();
    return null;
  }
  const prefix = `llmtest:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: 'redis',
    redis,
    process: () => new RedisGuardStore(() => redis, prefix),
    advance: (ms) => new Promise((r) => setTimeout(r, ms)),
    done: async () => {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit().catch(() => undefined);
    },
  };
}

const redisUrl = process.env.TEST_REDIS_URL || process.env.REDIS_URL || '';

async function rigs(): Promise<Rig[]> {
  const out = [await memoryRig()];
  if (redisUrl) {
    const r = await redisRig(redisUrl);
    if (r) out.push(r);
  }
  return out;
}

let seq = 0;
const base = (over: Partial<AcquireParams> = {}): AcquireParams => ({
  provider: 'anthropic',
  leaseId: `lease-${++seq}`,
  priority: 'cron',
  estimate: 100,
  rpm: 6000,
  tokenBudget: 1_000_000,
  costBudgetMicros: 1_000_000_000,
  reservePct: 10,
  leaseTtlMs: 60_000,
  probeTtlMs: 60_000,
  ...over,
});

const rec = (p: AcquireParams, day: string, over: Partial<RecordParams> = {}): RecordParams => ({
  provider: p.provider,
  leaseId: p.leaseId,
  day,
  estimate: p.estimate,
  probe: false,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  outcome: 'ok',
  failureThreshold: 3,
  openMs: 300,
  openUntilMidnight: false,
  ...over,
});

async function ok(store: LlmGuardStore, p: AcquireParams) {
  const r = await store.acquire(p);
  assert.equal(r.ok, true, `expected acquire to succeed, got ${JSON.stringify(r)}`);
  return r as Extract<typeof r, { ok: true }>;
}

async function denied(store: LlmGuardStore, p: AcquireParams, reason: string) {
  const r = await store.acquire(p);
  assert.equal(r.ok, false, 'expected acquire to be refused');
  assert.equal((r as any).reason, reason);
  return r as Extract<typeof r, { ok: false }>;
}

// ── Scenario table (runs on every available rig) ─────────────────────────────
const scenarios: Array<[string, (rig: Rig) => Promise<void>]> = [
  ['token bucket refills at RPM and rejects bursts across two processes', async (rig) => {
    const [a, b] = [rig.process(), rig.process()];
    const rpm = 120; // capacity 120, one token per 500 ms
    for (let i = 0; i < rpm; i++) await ok(i % 2 ? a : b, base({ rpm, estimate: 1 }));
    const limited = await denied(a, base({ rpm, estimate: 1 }), 'RATE_LIMITED');
    assert.ok(limited.retryAfterMs > 0 && limited.retryAfterMs <= 500, `retryAfter ${limited.retryAfterMs}`);
    await denied(b, base({ rpm, estimate: 1 }), 'RATE_LIMITED');
    await rig.advance(560);
    await ok(b, base({ rpm, estimate: 1 }));
    await denied(a, base({ rpm, estimate: 1 }), 'RATE_LIMITED');
  }],

  ['cron calls stop at budget minus reserve; admin calls continue to the full budget', async (rig) => {
    const s = rig.process();
    const cfg = { tokenBudget: 1000, reservePct: 10, estimate: 100 };
    for (let i = 0; i < 9; i++) await ok(s, base({ ...cfg }));
    const stop = await denied(s, base({ ...cfg }), 'BUDGET_EXCEEDED');
    assert.ok(stop.retryAfterMs > 0, 'points at the UTC midnight reset');
    await ok(s, base({ ...cfg, priority: 'admin' }));
    await denied(s, base({ ...cfg, priority: 'admin' }), 'BUDGET_EXCEEDED');
  }],

  ['cost budget stops cron before admin', async (rig) => {
    const s = rig.process();
    const p0 = base({ costBudgetMicros: 1000, reservePct: 10 });
    const lease = await ok(s, p0);
    await s.record(rec(p0, lease.day, { costMicros: 950, inputTokens: 10 }));
    await denied(s, base({ costBudgetMicros: 1000, reservePct: 10 }), 'BUDGET_EXCEEDED');
    await ok(s, base({ costBudgetMicros: 1000, reservePct: 10, priority: 'admin' }));
  }],

  ['a daily-quota error opens the breaker for every process; half-open admits exactly one probe', async (rig) => {
    const [a, b, c] = [rig.process(), rig.process(), rig.process()];
    const p = base();
    const lease = await ok(a, p);
    await a.record(rec(p, lease.day, { outcome: 'quota', openMs: 300 }));
    assert.equal(await b.breakerState('anthropic'), 'open');
    await denied(b, base(), 'CIRCUIT_OPEN');
    await denied(c, base(), 'CIRCUIT_OPEN');
    assert.equal(await b.breakerState('gemini'), 'closed', 'breakers are per provider');

    await rig.advance(360);
    assert.equal(await b.breakerState('anthropic'), 'half-open');
    const probe = base();
    const granted = await ok(b, probe);
    assert.equal(granted.probe, true);
    await denied(a, base(), 'CIRCUIT_OPEN');
    await denied(c, base(), 'CIRCUIT_OPEN');

    // probe success closes it for everyone
    await b.record(rec(probe, granted.day, { probe: true, outcome: 'ok' }));
    assert.equal(await a.breakerState('anthropic'), 'closed');
    await ok(a, base());
    await ok(c, base());
  }],

  ['probe failure reopens the breaker; consecutive errors open it at the threshold', async (rig) => {
    const s = rig.process();
    const t = { failureThreshold: 2, openMs: 300 };
    for (let i = 0; i < 2; i++) {
      const p = base();
      const l = await ok(s, p);
      await s.record(rec(p, l.day, { outcome: 'error', ...t }));
    }
    await denied(s, base(), 'CIRCUIT_OPEN');

    await rig.advance(360);
    const probe = base();
    const granted = await ok(s, probe);
    assert.equal(granted.probe, true);
    await s.record(rec(probe, granted.day, { probe: true, outcome: 'error', ...t }));
    await denied(s, base(), 'CIRCUIT_OPEN');

    // a success between failures resets the count
    await rig.advance(360);
    const again = base();
    const g2 = await ok(s, again);
    await s.record(rec(again, g2.day, { probe: true, outcome: 'ok', ...t }));
    const p1 = base();
    const l1 = await ok(s, p1);
    await s.record(rec(p1, l1.day, { outcome: 'error', ...t }));
    const p2 = base();
    const l2 = await ok(s, p2);
    await s.record(rec(p2, l2.day, { outcome: 'ok', ...t }));
    const p3 = base();
    const l3 = await ok(s, p3);
    await s.record(rec(p3, l3.day, { outcome: 'error', ...t }));
    await ok(s, base());
  }],

  ['a hung probe does not block recovery forever', async (rig) => {
    const s = rig.process();
    const p = base();
    const l = await ok(s, p);
    await s.record(rec(p, l.day, { outcome: 'quota', openMs: 250 }));
    await rig.advance(300);
    const hung = await ok(s, base({ probeTtlMs: 200 }));
    assert.equal(hung.probe, true);
    await denied(s, base(), 'CIRCUIT_OPEN');
    await rig.advance(260);
    const next = await ok(s, base({ probeTtlMs: 200 }));
    assert.equal(next.probe, true, 'the stale probe was replaced');
  }],

  ['reservations are released on error and on missing usage metadata', async (rig) => {
    const s = rig.process();
    const usage = async () => (await s.usage());

    const p1 = base({ estimate: 400 });
    const l1 = await ok(s, p1);
    assert.equal((await usage()).reserved, 400);
    await s.record(rec(p1, l1.day, { outcome: 'error' }));
    assert.equal((await usage()).reserved, 0);

    const p2 = base({ estimate: 400 });
    const l2 = await ok(s, p2);
    await s.record(rec(p2, l2.day, { outcome: 'ok' })); // no usage metadata
    let u = await usage();
    assert.equal(u.reserved, 0);
    assert.equal(u.tokens, 0);

    const p3 = base({ estimate: 400 });
    const l3 = await ok(s, p3);
    await s.record(rec(p3, l3.day, { inputTokens: 300, outputTokens: 50, costMicros: 777 }));
    u = await usage();
    assert.deepEqual([u.reserved, u.tokens, u.costMicros], [0, 350, 777]);
  }],

  ['a lease that is never recorded is reclaimed after its TTL', async (rig) => {
    const s = rig.process();
    await ok(s, base({ estimate: 500, leaseTtlMs: 200 }));
    assert.equal((await s.usage()).reserved, 500);
    await rig.advance(260);
    await ok(s, base({ estimate: 10 }));
    assert.equal((await s.usage()).reserved, 10, 'the crashed call no longer counts');
  }],

  ['recording a reclaimed lease does not release its reservation twice', async (rig) => {
    const s = rig.process();
    const dead = base({ estimate: 500, leaseTtlMs: 200 });
    const l = await ok(s, dead);
    await rig.advance(260);
    await ok(s, base({ estimate: 10 })); // reclaims `dead`
    await s.record(rec(dead, l.day, { estimate: 500, inputTokens: 5 }));
    assert.equal((await s.usage()).reserved, 10);
  }],

  ['setOnce dedupes within its TTL', async (rig) => {
    const s = rig.process();
    assert.equal(await s.setOnce('budget-alert:x', 60), true);
    assert.equal(await rig.process().setOnce('budget-alert:x', 60), false);
  }],
];

for (const [title, run] of scenarios) {
  test(title, async (t) => {
    const all = await rigs();
    for (const rig of all) {
      try {
        await t.test(rig.name, async () => run(rig));
      } finally {
        await rig.done();
      }
    }
  });
}

test('redis store: EVALSHA falls back to EVAL after SCRIPT FLUSH', async (t) => {
  if (!redisUrl) return t.skip('no Redis URL');
  const rig = await redisRig(redisUrl);
  if (!rig) return t.skip('Redis not reachable');
  try {
    const s = rig.process();
    await ok(s, base());
    await rig.redis!.script('FLUSH');
    await ok(s, base());
    const p = base();
    const l = await ok(s, p);
    await rig.redis!.script('FLUSH');
    await s.record(rec(p, l.day, { inputTokens: 1 }));
  } finally {
    await rig.done();
  }
});

test('the budget day comes from the store clock and rolls over at UTC midnight', async () => {
  const { MemoryGuardStore } = await import('../src/lib/llm-budget-store');
  let now = Date.UTC(2026, 9, 18, 23, 59, 0);
  const s = new MemoryGuardStore(() => now);
  const cfg = { tokenBudget: 200, estimate: 100, reservePct: 0 };
  const a = await ok(s, base(cfg));
  await ok(s, base(cfg));
  await denied(s, base(cfg), 'BUDGET_EXCEEDED');
  assert.equal(a.day, '2026-10-18');
  now = Date.UTC(2026, 9, 19, 0, 1, 0);
  const next = await ok(s, base(cfg));
  assert.equal(next.day, '2026-10-19');
});

// ── High-level behaviour (acquire / record / callLLMStructured) ───────────────
async function highLevel() {
  const budget = await import('../src/lib/llm-budget');
  const llm = await import('../src/lib/llm');
  const schema = await import('../src/lib/llm-schema');
  const store = new budget.MemoryGuardStore();
  const prevStore = budget.setLlmGuardStore(store);
  budget.setLlmGuardSettings({ rpm: { anthropic: 6000, gemini: 6000 } });
  budget.resetLocalLlmLimiter();
  return {
    budget, llm, schema, store,
    cleanup() {
      llm.setAnthropicClient(null);
      llm.setGeminiModelFactory(null);
      budget.setLlmGuardStore(prevStore);
      budget.setLlmGuardSettings({});
      budget.setLlmWait(null);
    },
  };
}

const goodInput = {
  market_question: 'Will the Federal Reserve hold the federal funds rate unchanged at its next FOMC meeting?',
  initial_yes_probability: 0.64, resolution_oracle: 'FRED', expiry_timestamp: 4102444800,
  settlement_currency: 'USDC', minimum_liquidity_usdc: 100, category: 'FED',
  confidence_interval: { lower: 0.54, upper: 0.74 }, reasoning: 'Flat rates.', grounding_signal_ids: ['f1'],
};
const toolUse = (input: unknown, usage = { input_tokens: 1000, output_tokens: 200 }) => ({
  content: [{ type: 'tool_use', id: 't1', name: 'submit_market_proposal', input }], stop_reason: 'tool_use', usage,
});
const P = { system: 'sys', user: 'user' };

test('usage is read from Anthropic message.usage and Gemini usageMetadata into the daily counters', async () => {
  const h = await highLevel();
  try {
    h.llm.setAnthropicClient({ messages: { create: async () => toolUse(goodInput, { input_tokens: 1412, output_tokens: 231 }) } });
    const r = await h.llm.callLLMStructured(h.schema.marketProposalSpec, P, { ctx: { purpose: 'market_generation', priority: 'cron' } });
    assert.equal(r.provider, 'anthropic');
    let u = await h.store.usage();
    assert.equal(u.tokens, 1643);
    assert.equal(u.costMicros, Math.ceil((1412 * 3000 + 231 * 15000) / 1000));
    assert.equal(u.reserved, 0);

    h.llm.setAnthropicClient(null);
    h.llm.setGeminiModelFactory(() => ({
      generateContent: async () => ({
        response: { text: () => JSON.stringify(goodInput), usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } },
      }),
    }));
    await h.llm.callLLMStructured(h.schema.marketProposalSpec, P);
    u = await h.store.usage();
    assert.equal(u.tokens, 1643 + 1100);
    assert.equal(u.costMicros, Math.ceil((1412 * 3000 + 231 * 15000) / 1000) + Math.ceil((1000 * 100 + 100 * 400) / 1000));
  } finally {
    h.cleanup();
  }
});

test('falling back from anthropic to gemini does not double-reserve', async () => {
  const h = await highLevel();
  try {
    const err: any = new Error('boom');
    err.status = 500;
    h.llm.setAnthropicClient({ messages: { create: async () => { throw err; } } });
    let reservedDuringGemini = -1;
    h.llm.setGeminiModelFactory(() => ({
      generateContent: async () => {
        reservedDuringGemini = (await h.store.usage()).reserved;
        return { response: { text: () => JSON.stringify(goodInput), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } } };
      },
    }));
    const r = await h.llm.callLLMStructured(h.schema.marketProposalSpec, P, { maxTokens: 500 });
    assert.equal(r.provider, 'gemini');
    const expected = Math.ceil(('sys'.length + JSON.stringify([{ role: 'user', parts: [{ text: 'user' }] }]).length) / 4) + 500;
    assert.equal(reservedDuringGemini, expected, 'only the gemini reservation is held; anthropic was released first');
    assert.equal((await h.store.usage()).reserved, 0);
  } finally {
    h.cleanup();
  }
});

test('cron generation stops at the budget while admin generation still runs', async () => {
  const h = await highLevel();
  try {
    h.llm.setAnthropicClient({ messages: { create: async () => toolUse(goodInput) } });
    h.budget.setLlmGuardSettings({ rpm: { anthropic: 6000, gemini: 6000 }, tokenBudget: 3000, reservePct: 25 }); // cron cap 2250, admin cap 3000
    const call = (priority: 'cron' | 'admin') =>
      h.llm.callLLMStructured(h.schema.marketProposalSpec, P, { maxTokens: 1200, ctx: { purpose: 'x', priority } });
    await call('cron'); // reserves ~1200, then bills the actual 1200
    await assert.rejects(call('cron'), (e: any) => e.code === 'LLM_BUDGET_EXCEEDED' && e.statusCode === 429);
    const admin = await call('admin');
    assert.equal(admin.provider, 'anthropic');
  } finally {
    h.cleanup();
  }
});

test('the budget alert is claimed once per day', async () => {
  const h = await highLevel();
  try {
    assert.equal(await h.budget.claimDailyOnce('budget-exceeded'), true);
    assert.equal(await h.budget.claimDailyOnce('budget-exceeded'), false);
  } finally {
    h.cleanup();
  }
});

const downStore = (): LlmGuardStore => {
  const fail = async () => { throw new Error('ECONNREFUSED'); };
  return { acquire: fail, record: fail, breakerState: fail, usage: fail, setOnce: fail } as unknown as LlmGuardStore;
};

test('redis unavailable, fail-closed: acquire throws LLM_CIRCUIT_OPEN with GUARD_STORE_UNAVAILABLE', async () => {
  const h = await highLevel();
  h.budget.setLlmGuardStore(downStore());
  h.budget.setLlmGuardSettings({ failMode: 'closed' });
  try {
    await assert.rejects(
      h.budget.acquire('anthropic', { purpose: 'x', priority: 'cron' }, 10),
      (e: any) => e.code === 'LLM_CIRCUIT_OPEN' && e.statusCode === 503 && e.details.reason === 'GUARD_STORE_UNAVAILABLE',
    );
    let called = false;
    h.llm.setAnthropicClient({ messages: { create: async () => { called = true; return toolUse(goodInput); } } });
    await assert.rejects(h.llm.callLLMStructured(h.schema.marketProposalSpec, P), (e: any) => e.code === 'LLM_CIRCUIT_OPEN');
    assert.equal(called, false, 'no provider call is made without the shared guard');
  } finally {
    h.cleanup();
  }
});

test('redis unavailable, fail-open: a per-process limiter takes over', async () => {
  const h = await highLevel();
  h.budget.setLlmGuardStore(downStore());
  h.budget.setLlmGuardSettings({ failMode: 'open', rpm: { anthropic: 2, gemini: 2 }, maxWaitMs: 50 });
  try {
    const ctx = { purpose: 'x', priority: 'cron' as const };
    const first = await h.budget.acquire('anthropic', ctx, 10);
    assert.equal(first.local, true);
    await h.budget.acquire('anthropic', ctx, 10);
    await assert.rejects(h.budget.acquire('anthropic', ctx, 10), (e: any) => e.code === 'LLM_RATE_LIMITED');
    await h.budget.record(first, null, 'ok'); // a dead store never fails the caller

    h.llm.setAnthropicClient({ messages: { create: async () => toolUse(goodInput) } });
    h.budget.setLlmGuardSettings({ failMode: 'open', rpm: { anthropic: 600, gemini: 600 } });
    const r = await h.llm.callLLMStructured(h.schema.marketProposalSpec, P);
    assert.equal(r.provider, 'anthropic');
  } finally {
    h.cleanup();
  }
});

test('RATE_LIMITED waits for a token instead of failing', async () => {
  const h = await highLevel();
  let now = Date.UTC(2026, 9, 18, 10, 0, 0);
  const { MemoryGuardStore } = h.budget;
  const store = new MemoryGuardStore(() => now);
  h.budget.setLlmGuardStore(store);
  h.budget.setLlmGuardSettings({ rpm: { anthropic: 60, gemini: 60 } });
  const waits: number[] = [];
  h.budget.setLlmWait(async (ms) => { waits.push(ms); now += ms; });
  try {
    const ctx = { purpose: 'x', priority: 'cron' as const };
    for (let i = 0; i < 60; i++) await h.budget.acquire('anthropic', ctx, 1);
    await h.budget.acquire('anthropic', ctx, 1); // 61st: waits ~1 s for a refill
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 1000 && waits[0] <= 1300, `waited ${waits[0]}`);
  } finally {
    h.cleanup();
  }
});

test('the Anthropic SDK client is built with maxRetries 0 so the limiter sees every attempt', async () => {
  const { setSecretsForTest, SECRET_NAMES } = await import('../src/config/secrets');
  setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, n === 'ANTHROPIC_API_KEY' ? 'sk-ant-test' : ''])) as any);
  try {
    const { getAnthropicClient } = await import('../src/lib/llm/providers/anthropic');
    assert.equal((getAnthropicClient() as any).maxRetries, 0);
  } finally {
    setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, ''])) as any);
  }
});
