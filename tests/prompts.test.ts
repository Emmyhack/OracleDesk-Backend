/**
 * Prompt registry and LLM provenance (#66). No network: providers are the
 * setAnthropicClient / setGeminiModelFactory / setLlmJsonCaller seams, Prisma
 * is monkeypatched and IPFS is in memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/env';

process.env.ANTHROPIC_API_KEY = '';
process.env.GEMINI_API_KEY = '';
setupTestEnv();

const ROOT = join(__dirname, '..', '..');
const fixture = (name: string) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'llm', `${name}.json`), 'utf8'));
const SNAPSHOT = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'prompts.snapshot.json'), 'utf8')) as Array<{
  id: string; version: number; contentHash: string;
}>;
const PROMPTS = { system: 'You create markets.', user: 'Signals: <untrusted_signals nonce="x">…</untrusted_signals nonce="x">' };
const REF = { id: 'market-proposal', version: 1, hash: 'a'.repeat(64) };

/** The CI rule: a changed template must come with a version bump. */
function checkAgainstSnapshot(
  current: Array<{ id: string; version: number; contentHash: string }>,
): string[] {
  const problems: string[] = [];
  for (const snap of SNAPSHOT) {
    const now = current.find((p) => p.id === snap.id && p.version === snap.version);
    if (!now) problems.push(`${snap.id}@${snap.version} was removed; old versions must stay registered`);
    else if (now.contentHash !== snap.contentHash) {
      problems.push(`${snap.id}@${snap.version}: template changed; bump version (add a new version file) instead of editing`);
    }
  }
  for (const p of current) {
    if (!SNAPSHOT.some((s) => s.id === p.id && s.version === p.version)) {
      problems.push(`${p.id}@${p.version} is new; add it to tests/fixtures/prompts.snapshot.json`);
    }
  }
  return problems;
}

function fakeAnthropic(responses: any[]) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (body: any) => {
          calls.push(JSON.parse(JSON.stringify(body)));
          const r = responses[Math.min(calls.length - 1, responses.length - 1)];
          if (r instanceof Error) throw r;
          return JSON.parse(JSON.stringify(r));
        },
      },
    },
  };
}

function fakeGemini(responses: any[]) {
  let i = 0;
  return (_params: any) => {
    return {
      generateContent: async () => {
        const r = responses[Math.min(i++, responses.length - 1)];
        return { response: { text: () => r.candidates[0].content.parts[0].text, usageMetadata: r.usageMetadata } };
      },
    };
  };
}

async function harness() {
  const llm = await import('../src/lib/llm');
  const budget = await import('../src/lib/llm-budget');
  const schema = await import('../src/lib/llm-schema');
  const prevStore = budget.setLlmGuardStore(new budget.MemoryGuardStore());
  budget.setLlmGuardSettings({ rpm: { anthropic: 6000, gemini: 6000 } });
  return {
    llm, schema,
    cleanup() {
      llm.setAnthropicClient(null);
      llm.setGeminiModelFactory(null);
      budget.setLlmGuardStore(prevStore);
      budget.setLlmGuardSettings({});
    },
  };
}

// ─── Registry ────────────────────────────────────────────────────────────────
test('prompt registry snapshot: ids, versions and content hashes are stable', async () => {
  const { listPrompts } = await import('../src/lib/prompts');
  assert.deepEqual(checkAgainstSnapshot(listPrompts()), []);
  for (const p of listPrompts()) assert.match(p.contentHash, /^[0-9a-f]{64}$/);
});

test('changing a template without bumping the version is reported', async () => {
  const { listPrompts, getPrompt, definePrompt } = await import('../src/lib/prompts');
  const original = getPrompt('hedge-conditions', 1);
  const edited = definePrompt({
    id: original.id,
    version: original.version,
    system: original.system,
    user: original.user.replace('early close', 'immediate close'),
  });
  assert.notEqual(edited.contentHash, original.contentHash);
  const current = listPrompts().map((p) => (p.id === edited.id ? { ...p, contentHash: edited.contentHash } : p));
  const problems = checkAgainstSnapshot(current);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /template changed; bump version/);
});

test('render fills placeholders in one pass and rejects a missing variable', async () => {
  const { definePrompt } = await import('../src/lib/prompts');
  const p = definePrompt<{ a: string; b: string }>({ id: 't', version: 1, system: 's', user: '{{a}}-{{b}}' });
  assert.equal(p.render({ a: '{{b}}', b: 'x' }).user, '{{b}}-x', 'a value is never re-expanded');
  assert.throws(() => p.render({ a: '1' } as any), /missing variable "b"/);
});

test('every registered version stays importable', async () => {
  const { getPrompt } = await import('../src/lib/prompts');
  assert.equal(getPrompt('market-proposal', 1).version, 1);
  assert.equal(getPrompt('market-proposal').version, 1, 'defaults to the current version');
  assert.throws(() => getPrompt('market-proposal', 99), /Unknown prompt/);
});

// ─── LLM layer ───────────────────────────────────────────────────────────────
test('anthropic success records provider, model, prompt hash, usage and outputSha256', async () => {
  const h = await harness();
  const a = fakeAnthropic([fixture('anthropic-tool-use-success')]);
  h.llm.setAnthropicClient(a.client);
  try {
    const { sha256Hex, canonicalJson } = await import('../src/utils/hash.util');
    const r = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS, { maxTokens: 4096, prompt: REF });
    const p = r.provenance;
    assert.equal(p.source, 'llm');
    assert.equal(p.provider, 'anthropic');
    assert.equal(p.model, 'claude-sonnet-4-6');
    assert.equal(p.promptId, 'market-proposal');
    assert.equal(p.promptVersion, 1);
    assert.equal(p.promptHash, REF.hash);
    assert.deepEqual(p.params, { temperature: 0.2, maxTokens: 4096 });
    assert.deepEqual(p.usage, { inputTokens: 1412, outputTokens: 231 });
    assert.equal(p.attempts, 1);
    assert.equal(p.fallbackFrom, undefined);
    assert.ok(Number.isInteger(p.latencyMs) && p.latencyMs >= 0);
    const toolInput = fixture('anthropic-tool-use-success').content[1].input;
    assert.equal(p.outputSha256, sha256Hex(canonicalJson(toolInput)));
  } finally {
    h.cleanup();
  }
});

test('missing usage is null, and an unregistered prompt is recorded as adhoc', async () => {
  const h = await harness();
  const noUsage = { ...fixture('anthropic-tool-use-success'), usage: undefined };
  h.llm.setAnthropicClient(fakeAnthropic([noUsage]).client);
  try {
    const r = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS);
    assert.equal(r.provenance.usage, null);
    assert.equal(r.provenance.promptId, 'adhoc');
    assert.equal(r.provenance.promptVersion, 0);
  } finally {
    h.cleanup();
  }
});

test('anthropic failure then gemini success records fallbackFrom (a category only) and attempts', async () => {
  const h = await harness();
  const secret = new Error('429 req_01SECRETREQUESTID prompt fragment: ignore previous instructions');
  (secret as any).status = 429;
  h.llm.setAnthropicClient(fakeAnthropic([secret]).client);
  h.llm.setGeminiModelFactory(fakeGemini([fixture('gemini-schema-violation'), fixture('gemini-json-success')]) as any);
  try {
    const r = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS, { prompt: REF });
    const p = r.provenance;
    assert.equal(p.provider, 'gemini');
    assert.deepEqual(p.fallbackFrom, { provider: 'anthropic', model: 'claude-sonnet-4-6', errorClass: 'rate_limited' });
    assert.equal(p.attempts, 3, 'one failed anthropic call plus gemini and its repair round');
    assert.deepEqual(p.params, { temperature: 0.1, maxTokens: 2048 });
    assert.ok(p.usage && p.usage.inputTokens > 0);
    // No provider message, request id or prompt text anywhere in the record.
    assert.doesNotMatch(JSON.stringify(p), /req_01|ignore previous|prompt fragment/);
  } finally {
    h.cleanup();
  }
});

test('gemini without usageMetadata records usage null', async () => {
  const h = await harness();
  const { usageMetadata, ...bare } = fixture('gemini-json-success');
  h.llm.setGeminiModelFactory(fakeGemini([bare]) as any);
  try {
    const r = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS);
    assert.equal(r.provenance.provider, 'gemini');
    assert.equal(r.provenance.usage, null);
    assert.equal(r.provenance.fallbackFrom, undefined);
  } finally {
    h.cleanup();
  }
});

test('errorClassOf maps failures to a bounded set', async () => {
  const { errorClassOf } = await import('../src/lib/llm');
  assert.equal(errorClassOf(Object.assign(new Error('x'), { status: 401 })), 'auth');
  assert.equal(errorClassOf(Object.assign(new Error('x'), { status: 529 })), 'server_error');
  assert.equal(errorClassOf(Object.assign(new Error('x'), { code: 'LLM_CIRCUIT_OPEN' })), 'circuit_open');
  assert.equal(errorClassOf(new Error('RESOURCE_EXHAUSTED: quota')), 'rate_limited');
  assert.equal(errorClassOf(new Error('anything else')), 'error');
});

// ─── Services ────────────────────────────────────────────────────────────────
const TRACE_INPUT = {
  marketId: 'm1',
  agentType: 'TRADER' as const,
  decisionType: 'OPEN_POSITION',
  sourcesUsed: [{ source: 'FRED', weight: 0.9, signal: 'CPI', rawValue: 0.6 }],
  probabilityEstimate: 0.6,
  marketProbability: 0.5,
  edge: 0.1,
  confidenceInterval: { lower: 0.5, upper: 0.7 },
  betFraction: 0.05,
  betSizeUsdc: 10,
  agentWallet: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
};

async function withTraceDb<T>(fn: (rows: any[]) => Promise<T>): Promise<T> {
  const { prisma } = await import('../src/lib/prisma');
  const original = prisma.reasoningTrace.create;
  const rows: any[] = [];
  (prisma.reasoningTrace.create as any) = async ({ data }: any) => { rows.push(data); return { id: 't1', ...data }; };
  try { return await fn(rows); } finally { (prisma.reasoningTrace.create as any) = original; }
}

test('hedge defaults record source=default, the prompt and no model', async () => {
  const llm = await import('../src/lib/llm');
  const budget = await import('../src/lib/llm-budget');
  const { generateReasoningTrace } = await import('../src/services/reasoning.service');
  const prev = llm.setLlmJsonCaller(async () => { throw new Error('provider exploded'); });
  const prevStore = budget.setLlmGuardStore(new budget.MemoryGuardStore());
  try {
    await withTraceDb(async (rows) => {
      const { tracePayload } = await generateReasoningTrace(TRACE_INPUT);
      const prov = (tracePayload as any).provenance;
      assert.equal(prov.schema, 'oracledesk.trace.provenance/1');
      assert.deepEqual(prov.llm, [{ source: 'default', promptId: 'hedge-conditions', promptVersion: 1, reason: 'LLM_FAILED' }]);
      assert.equal(prov.generator.service, 'oracledesk-backend');
      assert.match(prov.generator.version, /^\d+\.\d+\.\d+/);
      assert.deepEqual(rows[0].provenance, prov, 'persisted on the ReasoningTrace row');
      assert.match(String((tracePayload as any).hedgeConditions[0]), /Close if market probability/);
    });
  } finally {
    llm.setLlmJsonCaller(prev);
    budget.setLlmGuardStore(prevStore);
  }
});

test('tracePayload.provenance is canonical-safe and part of the pinned bytes', async () => {
  const llm = await import('../src/lib/llm');
  const budget = await import('../src/lib/llm-budget');
  const ipfs = await import('../src/services/ipfs.service');
  const { generateReasoningTrace } = await import('../src/services/reasoning.service');
  const { assertCanonicalSafe } = await import('../src/utils/hash.util');
  const store = new Map<string, Buffer>();
  const prevIpfs = ipfs.setIpfsTransport({
    pin: async (bytes: Uint8Array) => { const cid = `cid${store.size}`; store.set(cid, Buffer.from(bytes)); return cid; },
    fetch: async (cid: string) => store.get(cid)!,
  } as any);
  const prev = llm.setLlmJsonCaller(async () => JSON.stringify({
    hedge_conditions: ['Close if CPI exceeds 3.5%'], reasoning_summary: 'CPI drives the thesis.', key_signals: ['CPI'], risk_factors: ['Revision'],
  }));
  const prevStore = budget.setLlmGuardStore(new budget.MemoryGuardStore());
  try {
    await withTraceDb(async () => {
      const { tracePayload } = await generateReasoningTrace(TRACE_INPUT);
      assertCanonicalSafe((tracePayload as any).provenance);
      const pinned = await ipfs.pinJson(tracePayload, 'trace');
      const doc = JSON.parse(pinned.bytes.toString('utf8'));
      assert.equal(doc.provenance.schema, 'oracledesk.trace.provenance/1');
      assert.equal(doc.provenance.llm[0].source, 'llm');
      assert.equal(doc.provenance.llm[0].promptId, 'hedge-conditions');
      assert.match(doc.provenance.llm[0].outputSha256, /^[0-9a-f]{64}$/);
      // no raw prompt or output text is pinned
      assert.doesNotMatch(pinned.bytes.toString('utf8'), /quantitative prediction market risk manager|Close if CPI exceeds 3\.5%.*Close if CPI exceeds/s);
    });
  } finally {
    ipfs.setIpfsTransport(prevIpfs);
    llm.setLlmJsonCaller(prev);
    budget.setLlmGuardStore(prevStore);
  }
});

test('assertCanonicalSafe rejects undefined, Date and non-finite numbers', async () => {
  const { assertCanonicalSafe } = await import('../src/utils/hash.util');
  assert.throws(() => assertCanonicalSafe({ a: undefined }), /undefined/);
  assert.throws(() => assertCanonicalSafe({ a: new Date() }), /Date/);
  assert.throws(() => assertCanonicalSafe({ a: [NaN] }), /non-finite/);
  assert.doesNotThrow(() => assertCanonicalSafe({ a: [1, 'x', null, true, { b: 2 }] }));
});

test('market generation provenance is stored on the Market and propagated into the creation trace', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const llm = await import('../src/lib/llm');
  const budget = await import('../src/lib/llm-budget');
  const { generateMarketQuestion, createMarketFromProposal } = await import('../src/services/market.service');
  const { generateReasoningTrace } = await import('../src/services/reasoning.service');
  const { marketProposalV1 } = await import('../src/lib/prompts');

  const orig = { findMany: prisma.market.findMany, mcreate: prisma.market.create, alog: prisma.agentLog.create };
  const created: any[] = [];
  (prisma.market.findMany as any) = async () => [];
  (prisma.market.create as any) = async ({ data }: any) => { created.push(data); return { id: 'mk1', ...data }; };
  (prisma.agentLog.create as any) = async ({ data }: any) => data;
  const prev = llm.setLlmJsonCaller(async (_s, user) => {
    return user.includes('hedge') || user.includes('Market ID')
      ? JSON.stringify({ hedge_conditions: ['Close if CPI exceeds 3.5%'], reasoning_summary: 'CPI.', key_signals: ['CPI'], risk_factors: ['x'] })
      : JSON.stringify({
          market_question: 'Will the Federal Reserve keep the federal funds rate unchanged at its next FOMC meeting?',
          initial_yes_probability: 0.68, resolution_oracle: 'FRED',
          expiry_timestamp: Math.floor(Date.now() / 1000) + 30 * 86_400,
          settlement_currency: 'USDC', minimum_liquidity_usdc: 100, category: 'FED',
          confidence_interval: { lower: 0.58, upper: 0.78 },
          reasoning: 'FEDFUNDS is flat.', grounding_signal_ids: ['f1', 'n1'],
        });
  });
  const prevStore = budget.setLlmGuardStore(new budget.MemoryGuardStore());
  try {
    // Signals the injection guard accepts for this proposal (tests/fixtures/injection/fed-hold.json).
    const base = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'injection', 'fed-hold.json'), 'utf8'));
    const signals = { ...base.signals, aggregatedAt: new Date(), signalCount: 7 } as any;
    const { proposal, provenance } = await generateMarketQuestion(signals);
    assert.equal(provenance.promptId, 'market-proposal');
    assert.equal(provenance.promptHash, marketProposalV1.contentHash);

    await createMarketFromProposal(proposal, provenance);
    assert.deepEqual(created[0].generationProvenance, provenance);

    await withTraceDb(async (rows) => {
      const { tracePayload } = await generateReasoningTrace(
        { ...TRACE_INPUT, agentType: 'MARKET_MAKER', decisionType: 'MARKET_CREATION' },
        undefined,
        { upstreamProvenance: [provenance] },
      );
      const llmEntries = (tracePayload as any).provenance.llm;
      assert.deepEqual(llmEntries.map((e: any) => e.promptId), ['market-proposal', 'hedge-conditions']);
      assert.deepEqual(llmEntries[0], provenance);
      assert.deepEqual(rows[0].provenance.llm, llmEntries);
    });
  } finally {
    (prisma.market.findMany as any) = orig.findMany;
    (prisma.market.create as any) = orig.mcreate;
    (prisma.agentLog.create as any) = orig.alog;
    llm.setLlmJsonCaller(prev);
    budget.setLlmGuardStore(prevStore);
  }
});

// ─── Consumers ───────────────────────────────────────────────────────────────
test('summarizeProvenance reduces a block and tolerates traces that predate it', async () => {
  const { summarizeProvenance } = await import('../src/lib/llm/provenance');
  assert.equal(summarizeProvenance(null), null);
  assert.equal(summarizeProvenance({}), null);
  const block = {
    schema: 'oracledesk.trace.provenance/1',
    llm: [
      { source: 'llm', provider: 'anthropic', promptId: 'market-proposal', promptVersion: 1 },
      { source: 'default', promptId: 'hedge-conditions', promptVersion: 1, reason: 'LLM_FAILED' },
    ],
  };
  assert.deepEqual(summarizeProvenance(block), {
    providers: ['anthropic'],
    promptVersions: ['hedge-conditions@1', 'market-proposal@1'],
    source: 'mixed',
  });
});

test('a preview exposes provenance.summary only; full access exposes the block', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const sub = await import('../src/services/subscription.service');
  const block = {
    schema: 'oracledesk.trace.provenance/1',
    llm: [{ source: 'llm', provider: 'gemini', promptId: 'hedge-conditions', promptVersion: 1, outputSha256: 'f'.repeat(64) }],
    generator: { service: 'oracledesk-backend', version: '1.0.0' },
  };
  const row = (provenance: unknown) => ({
    id: 't1', marketId: 'm1', market: {}, agentType: 'TRADER', decisionType: 'X', probabilityEstimate: 0.6,
    marketProbability: 0.5, edge: 0.1, confidenceInterval: {}, previewSources: [], verified: false,
    ipfsCid: null, traceHash: null, onChainTraceId: null, createdAt: new Date(), lastAuditStatus: null, provenance,
  });
  const orig = prisma.reasoningTrace.findUnique;
  try {
    (prisma.reasoningTrace.findUnique as any) = async () => row(block);
    const preview = await sub.getTracWithAccessControl('t1');
    assert.deepEqual(preview.provenance, { summary: { providers: ['gemini'], promptVersions: ['hedge-conditions@1'], source: 'llm' } });
    assert.doesNotMatch(JSON.stringify(preview), /outputSha256/);

    (prisma.reasoningTrace.findUnique as any) = async () => row(null);
    const old = await sub.getTracWithAccessControl('t1');
    assert.deepEqual(old.provenance, { summary: null }, 'older traces still render');
  } finally {
    (prisma.reasoningTrace.findUnique as any) = orig;
  }
});
