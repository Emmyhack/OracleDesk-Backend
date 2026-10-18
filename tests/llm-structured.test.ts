/**
 * Provider-native structured outputs (#65). No network: Anthropic and Gemini
 * are replaced through setAnthropicClient / setGeminiModelFactory and replay
 * the response shapes in tests/fixtures/llm/. The fixtures follow the
 * Messages API and generateContent response shapes; they are hand-built
 * examples of those shapes, not captures from a live account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { setupTestEnv } from './helpers/env';

// Never let a developer's real keys make these tests reachable to a provider.
process.env.ANTHROPIC_API_KEY = '';
process.env.GEMINI_API_KEY = '';
setupTestEnv();

const FIXTURES = join(__dirname, '..', '..', 'tests', 'fixtures', 'llm');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

const PROMPTS = { system: 'You create markets.', user: 'Signals: <untrusted_signals nonce="x">…</untrusted_signals nonce="x">' };

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
  const calls: Array<{ params: any; contents: any }> = [];
  return {
    calls,
    factory: (params: any) => ({
      generateContent: async (contents: any) => {
        calls.push({ params, contents: JSON.parse(JSON.stringify(contents)) });
        const r = responses[Math.min(calls.length - 1, responses.length - 1)];
        if (r instanceof Error) throw r;
        const text = r.candidates[0].content.parts[0].text;
        return { response: { text: () => text, usageMetadata: r.usageMetadata } };
      },
    }),
  };
}

async function harness() {
  const llm = await import('../src/lib/llm');
  const gemini = await import('../src/lib/gemini');
  const budget = await import('../src/lib/llm-budget');
  const schema = await import('../src/lib/llm-schema');
  const prevStore = budget.setLlmGuardStore(new budget.MemoryGuardStore());
  budget.setLlmGuardSettings({ rpm: { anthropic: 6000, gemini: 6000 } });
  return {
    llm, gemini, budget, schema,
    cleanup() {
      llm.setAnthropicClient(null);
      llm.setGeminiModelFactory(null);
      budget.setLlmGuardStore(prevStore);
      budget.setLlmGuardSettings({});
    },
  };
}

test('wire schemas convert to JSON Schema without unrepresentable types', async () => {
  const { schema } = await import('../src/lib/llm-schema').then((schema) => ({ schema }));
  for (const spec of [schema.marketProposalSpec, schema.traceReasoningSpec]) {
    assert.equal(spec.jsonSchema.type, 'object');
    assert.equal(spec.jsonSchema.$schema, undefined);
    assert.deepEqual(
      [...spec.jsonSchema.required].sort(),
      Object.keys(spec.jsonSchema.properties).sort(),
      'every wire field is required (no .default/.catch made one optional)',
    );
  }
  assert.equal(schema.marketProposalSpec.jsonSchema.properties.settlement_currency.const, 'USDC');
  // A type with no JSON Schema form must fail loudly at definition time.
  assert.throws(() => schema.defineStructured('bad', 'bad', z.object({ at: z.date() })));
});

test('toGeminiSchema strips unsupported keywords and maps types (snapshot)', async () => {
  const { marketProposalSpec, toGeminiSchema } = await import('../src/lib/llm-schema');
  assert.deepEqual(marketProposalSpec.geminiSchema, fixture('gemini-market-proposal-schema'));

  const seen: string[] = [];
  const walk = (n: any) => {
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (k !== 'properties' && k !== 'enum') seen.push(k);
        if (k === 'properties') Object.values(v as object).forEach(walk);
        else walk(v);
      }
    }
  };
  walk(marketProposalSpec.geminiSchema);
  for (const banned of ['additionalProperties', '$schema', 'minLength', 'pattern', 'const', 'exclusiveMinimum']) {
    assert.ok(!seen.includes(banned), `${banned} must not reach Gemini`);
  }

  const converted = toGeminiSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      a: { type: 'string', minLength: 3, pattern: '^x', const: 'x' },
      b: { anyOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }] },
    },
    required: ['a'],
  });
  assert.deepEqual(converted, {
    type: 'object',
    properties: {
      a: { type: 'string', enum: ['x'], format: 'enum' },
      b: { type: 'number', minimum: 0, maximum: 1, nullable: true },
    },
    propertyOrdering: ['a', 'b'],
    required: ['a'],
  });
});

test('anthropic forced tool call returns a typed proposal', async () => {
  const h = await harness();
  const a = fakeAnthropic([fixture('anthropic-tool-use-success')]);
  h.llm.setAnthropicClient(a.client);
  try {
    const result = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS, { maxTokens: 4096 });
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.attempts, 1);
    assert.equal(result.value.category, 'FED');
    assert.deepEqual(result.value.grounding_signal_ids, ['f1']);

    const req = a.calls[0];
    assert.deepEqual(req.tool_choice, { type: 'tool', name: 'submit_market_proposal' });
    assert.equal(req.tools.length, 1);
    assert.equal(req.tools[0].name, 'submit_market_proposal');
    assert.deepEqual(req.tools[0].input_schema, h.schema.marketProposalSpec.jsonSchema);
    assert.equal(req.max_tokens, 4096);
    assert.doesNotMatch(req.system, /CRITICAL|markdown fences/, 'the schema replaces the prose JSON instructions');
    // the response had a text block before the tool_use block; it was skipped
    assert.equal(fixture('anthropic-tool-use-success').content[0].type, 'text');
  } finally {
    h.cleanup();
  }
});

test('anthropic invalid tool input triggers one repair turn with zod issues, then succeeds', async () => {
  const h = await harness();
  const a = fakeAnthropic([fixture('anthropic-tool-use-bad-probability'), fixture('anthropic-tool-use-success')]);
  h.llm.setAnthropicClient(a.client);
  try {
    const result = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS);
    assert.equal(result.attempts, 2);
    assert.equal(result.provider, 'anthropic');
    assert.equal(a.calls.length, 2);

    const repair = a.calls[1].messages;
    assert.equal(repair.length, 3);
    assert.equal(repair[1].role, 'assistant');
    assert.equal(repair[1].content[0].type, 'tool_use');
    const turn = repair[2].content[0];
    assert.equal(turn.type, 'tool_result');
    assert.equal(turn.is_error, true);
    assert.equal(turn.tool_use_id, 'toolu_01RecordedBad');
    assert.match(turn.content, /initial_yes_probability/);
  } finally {
    h.cleanup();
  }
});

test('confidence interval post-validation error is fed back in the repair turn', async () => {
  const h = await harness();
  const a = fakeAnthropic([fixture('anthropic-tool-use-bad-interval'), fixture('anthropic-tool-use-success')]);
  h.llm.setAnthropicClient(a.client);
  try {
    const result = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS);
    assert.equal(result.attempts, 2);
    const turn = a.calls[1].messages[2].content[0];
    assert.match(turn.content, /confidence_interval must satisfy lower < initial_yes_probability/);
  } finally {
    h.cleanup();
  }
});

test('anthropic repeated failure falls back to gemini structured output', async () => {
  const h = await harness();
  const a = fakeAnthropic([fixture('anthropic-tool-use-bad-probability')]);
  const g = fakeGemini([fixture('gemini-json-success')]);
  h.llm.setAnthropicClient(a.client);
  h.llm.setGeminiModelFactory(g.factory);
  try {
    const result = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.attempts, 3, 'two anthropic calls (one repair) plus one gemini call');
    assert.equal(a.calls.length, 2, 'exactly one repair per provider');

    const cfg = g.calls[0].params.generationConfig;
    assert.equal(cfg.responseMimeType, 'application/json');
    assert.deepEqual(cfg.responseSchema, h.schema.marketProposalSpec.geminiSchema);
  } finally {
    h.cleanup();
  }
});

test('gemini schema violation is repaired once, then fails with LLM_STRUCTURED_OUTPUT_FAILED', async () => {
  const h = await harness();
  const g = fakeGemini([fixture('gemini-schema-violation')]);
  h.llm.setGeminiModelFactory(g.factory);
  try {
    await assert.rejects(
      () => h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS),
      (err: any) => {
        assert.equal(err.code, 'LLM_STRUCTURED_OUTPUT_FAILED');
        assert.equal(err.statusCode, 422);
        assert.equal(err.details.provider, 'gemini');
        assert.match(err.details.issues.join('\n'), /category/);
        return true;
      },
    );
    assert.equal(g.calls.length, 2, 'one call plus exactly one repair');
    const contents = g.calls[1].contents;
    assert.equal(contents.length, 3);
    assert.equal(contents[1].role, 'model');
    assert.match(contents[2].parts[0].text, /failed validation/);
    assert.match(contents[2].parts[0].text, /category/);
  } finally {
    h.cleanup();
  }
});

test('a gemini reply wrapped in markdown fences is rejected, not repaired by stripping', async () => {
  const h = await harness();
  const fenced = {
    candidates: [{ content: { parts: [{ text: '```json\n' + fixture('gemini-json-success').candidates[0].content.parts[0].text + '\n```' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
  };
  const g = fakeGemini([fenced]);
  h.llm.setGeminiModelFactory(g.factory);
  try {
    await assert.rejects(
      () => h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS),
      (err: any) => err.code === 'LLM_STRUCTURED_OUTPUT_FAILED' && /not valid JSON/.test(err.details.issues.join('\n')),
    );
  } finally {
    h.cleanup();
  }
});

test('a truncated anthropic tool input raises the token budget once instead of repairing', async () => {
  const h = await harness();
  const a = fakeAnthropic([fixture('anthropic-truncated'), fixture('anthropic-tool-use-success')]);
  h.llm.setAnthropicClient(a.client);
  try {
    const result = await h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS, { maxTokens: 1000 });
    assert.equal(result.attempts, 2);
    assert.deepEqual(a.calls.map((c) => c.max_tokens), [1000, 2000]);
    assert.equal(a.calls[1].messages.length, 1, 'no repair turn was appended');
  } finally {
    h.cleanup();
  }
});

test('a budget rejection does not fall back to another provider', async () => {
  const h = await harness();
  const a = fakeAnthropic([fixture('anthropic-tool-use-success')]);
  const g = fakeGemini([fixture('gemini-json-success')]);
  h.llm.setAnthropicClient(a.client);
  h.llm.setGeminiModelFactory(g.factory);
  h.budget.setLlmGuardSettings({ rpm: { anthropic: 6000, gemini: 6000 }, tokenBudget: 10 });
  try {
    await assert.rejects(
      () => h.llm.callLLMStructured(h.schema.marketProposalSpec, PROMPTS),
      (err: any) => err.code === 'LLM_BUDGET_EXCEEDED',
    );
    assert.equal(a.calls.length + g.calls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('callLLMText falls back to a plain-text gemini call, not a JSON one', async () => {
  const h = await harness();
  const err: any = new Error('upstream exploded');
  err.status = 500;
  const a = fakeAnthropic([err]);
  const textResponse = {
    candidates: [{ content: { parts: [{ text: 'A plain-text answer.' }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
  };
  const g = fakeGemini([textResponse]);
  h.llm.setAnthropicClient(a.client);
  h.llm.setGeminiModelFactory(g.factory);
  try {
    const text = await h.llm.callLLMText('sys', 'user');
    assert.equal(text, 'A plain-text answer.');
    assert.equal(a.calls.length, 1);
    assert.equal(g.calls.length, 1);
    assert.equal(g.calls[0].params.generationConfig.responseMimeType, undefined);
    assert.equal(g.calls[0].params.generationConfig.responseSchema, undefined);
  } finally {
    h.cleanup();
  }
});

test('validateMarketQuestion rejects a fenced reply as invalid JSON', async () => {
  const { validateMarketQuestion } = await import('../src/services/market.service');
  const good = fixture('anthropic-tool-use-success').content[1].input;
  assert.equal(validateMarketQuestion(JSON.stringify(good)).category, 'FED');
  assert.throws(
    () => validateMarketQuestion('```json\n' + JSON.stringify(good) + '\n```'),
    (err: any) => err.code === 'INVALID_LLM_JSON',
  );
});

test('no fence-stripping code path remains in llm.ts, gemini.ts or market.service.ts', () => {
  for (const file of ['lib/llm.ts', 'lib/gemini.ts', 'services/market.service.ts']) {
    const source = readFileSync(join(__dirname, '..', '..', 'src', file), 'utf8');
    assert.doesNotMatch(source, /replace\([^)]*`{3}/, `${file} must not strip markdown fences`);
    assert.doesNotMatch(source, /stripFences/, file);
  }
});
