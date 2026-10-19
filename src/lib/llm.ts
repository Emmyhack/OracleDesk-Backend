/**
 * LLM entry point (#157, #65, #71).
 *
 * Free-form calls (`completeLLM`, `callLLMJSON`, `callLLMText`) go through the
 * provider-agnostic router. The default policy reproduces the historical
 * behaviour (Anthropic Claude first, Gemini fallback) while allowing per-task
 * policies via LLM_POLICY / LLM_POLICY_FILE.
 *
 * `callLLMStructured` is for output that must fit a zod schema: Anthropic via a
 * forced tool call, Gemini via `responseSchema`, one repair round per provider
 * that feeds the validation issues back, and no fence stripping anywhere.
 *
 * Every call runs inside the `llm` bulkhead and honours the shared deadline,
 * and every provider attempt takes a lease on the shared Redis guards
 * (src/lib/llm-budget.ts).
 */
import type { Content } from '@google/generative-ai';
import type Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../middlewares/error.middleware';
import { logger } from './logger';
import { createRouter } from './llm/router';
import { policies } from './llm/policy';
import { anthropicProvider, geminiProvider, openaiProvider } from './llm/providers';
import {
  classifyAnthropicError,
  getAnthropicClient,
  isAnthropicAvailable,
  setAnthropicClient,
} from './llm/providers/anthropic';
import type { LlmRequest, LlmResult, LlmTask } from './llm/types';
import {
  callGeminiStructured,
  isGeminiAvailable,
  setGeminiModelFactory,
  GEMINI_MODEL,
  GEMINI_STRUCTURED_TEMPERATURE,
} from './gemini';
import type { ErrorClass, LlmProvenance } from './llm/provenance';
import { canonicalJson, sha256Hex } from '../utils/hash.util';
import { formatIssues, type StructuredSpec } from './llm-schema';
import {
  DEFAULT_CALL_CONTEXT,
  LlmBudgetExceeded,
  estimateTokens,
  withLease,
  type CallContext,
} from './llm-budget';
import { bulkheads, deadline } from './resilience';

export const llmRouter = createRouter(policies, {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  openai: openaiProvider,
});

export type { LlmRequest, LlmResult, LlmTask };
export { LlmError } from './llm/types';
export { getAnthropicClient, setAnthropicClient, setGeminiModelFactory };

// ─── Provider transport seams (#72) ───────────────────────────────────────────
// Every Anthropic and Gemini request (router, structured output, repairs and
// fallbacks) leaves through these two functions when a transport is set, so a
// test can record and replay provider traffic without keys or a network.
// Production never sets one: the SDK clients are used as before.

/** One Anthropic Messages call, as sent and as answered. */
export interface AnthropicTransport {
  create(req: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

/** One Gemini generateContent call: the model parameters and the prompt (text or contents). */
export interface GeminiTransport {
  generate(req: {
    model: string;
    systemInstruction: string;
    generationConfig: object;
    prompt: unknown;
  }, opts?: { signal?: AbortSignal }): Promise<{ text: string; usage?: { promptTokenCount?: number; candidatesTokenCount?: number } }>;
}

let anthropicTransport: AnthropicTransport | null = null;
let geminiTransport: GeminiTransport | null = null;

/** Routes Anthropic calls to `t`; null restores the SDK. Returns the previous transport. */
export function setAnthropicTransport(t: AnthropicTransport | null): AnthropicTransport | null {
  const prev = anthropicTransport;
  anthropicTransport = t;
  setAnthropicClient(t ? { messages: { create: (body: any, opts?: any) => t.create(body, { signal: opts?.signal }) } } : null);
  return prev;
}

/** Routes Gemini calls to `t`; null restores the SDK. Returns the previous transport. */
export function setGeminiTransport(t: GeminiTransport | null): GeminiTransport | null {
  const prev = geminiTransport;
  geminiTransport = t;
  setGeminiModelFactory(
    t
      ? (params) => ({
          async generateContent(prompt: unknown, opts?: { signal?: AbortSignal }) {
            const r = await t.generate({
              model: params.model,
              systemInstruction: String((params as { systemInstruction?: unknown }).systemInstruction ?? ''),
              generationConfig: (params.generationConfig ?? {}) as object,
              prompt,
            }, opts);
            return { response: { text: () => r.text, usageMetadata: r.usage } };
          },
        })
      : null,
  );
  return prev;
}

/** Complete a request and return the text plus provenance. */
export async function completeLLM(req: LlmRequest): Promise<LlmResult> {
  return bulkheads.llm.run(async () => {
    const handle = deadline('llm', req.signal);
    try {
      return await llmRouter.complete({ ...req, signal: handle.signal });
    } finally {
      handle.cleanup?.();
    }
  }, req.signal);
}

// ─── Transport seam (#67) ─────────────────────────────────────────────────────

/**
 * One JSON completion, as the offline evaluation sees the model: raw text plus
 * who produced it. The default delegates to the router (Anthropic → Gemini);
 * `setLlmTransport` swaps in a recording transport so replay needs no keys and
 * no provider code runs.
 */
export interface LlmTransport {
  /**
   * With `opts.spec` the call is schema-constrained (the production path) and
   * the validated value comes back as JSON text; without it, free-form JSON.
   */
  json(
    system: string,
    user: string,
    maxTokens: number,
    opts?: { spec?: StructuredSpec<any> },
  ): Promise<{ text: string; provider: string; model: string }>;
}

const EVAL_CTX: CallContext = { purpose: 'eval', priority: 'admin' };

const defaultTransport: LlmTransport = {
  async json(system, user, maxTokens, opts) {
    if (opts?.spec) {
      const r = await callLLMStructured(opts.spec, { system, user }, { maxTokens, ctx: EVAL_CTX, task: 'market_generation' });
      return { text: JSON.stringify(r.value), provider: r.provider, model: r.model };
    }
    const result = await completeLLM({ task: 'market_generation', system, user, mode: 'json', maxTokens, ctx: EVAL_CTX });
    return { text: result.text, provider: result.provenance.provider, model: result.provenance.model };
  },
};

let transport: LlmTransport = defaultTransport;

/** Test/eval seam. Pass null to restore the provider-backed default. Returns the previous transport. */
export function setLlmTransport(next: LlmTransport | null): LlmTransport {
  const prev = transport;
  transport = next ?? defaultTransport;
  return prev;
}

export function getLlmTransport(): LlmTransport {
  return transport;
}

/** Backwards-compatible JSON wrapper. Invalid JSON triggers provider failover. */
export async function callLLMJSON(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  task: LlmTask = 'generic_json',
  opts?: { signal?: AbortSignal; ctx?: CallContext },
): Promise<string> {
  const result = await completeLLM({
    task,
    system: systemPrompt,
    user: userPrompt,
    mode: 'json',
    maxTokens,
    signal: opts?.signal,
    ctx: opts?.ctx,
  });
  return result.text;
}

/** Backwards-compatible plain-text wrapper. Never requests a JSON MIME type. */
export async function callLLMText(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  task: LlmTask = 'generic_text',
  opts?: { signal?: AbortSignal; ctx?: CallContext },
): Promise<string> {
  const result = await completeLLM({
    task,
    system: systemPrompt,
    user: userPrompt,
    mode: 'text',
    maxTokens,
    signal: opts?.signal,
    ctx: opts?.ctx,
  });
  return result.text;
}

// ─── Structured output (#65) ──────────────────────────────────────────────────

export type StructuredProvider = 'anthropic' | 'gemini';

/** What the serving provider contributes to provenance (#66). */
interface Served {
  provider: StructuredProvider;
  model: string;
  /** Provider requests made so far, repairs and 429 retries included. */
  attempts: number;
  outputSha256: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  params: { temperature: number; maxTokens: number };
}

export interface StructuredResult<T> {
  value: T;
  provider: StructuredProvider;
  model: string;
  /** Provider calls made, repairs included. */
  attempts: number;
  /** Who produced `value`, with which prompt and parameters (#66). */
  provenance: LlmProvenance;
}

/** Sampling temperature of the Anthropic forced-tool call; recorded in provenance. */
export const ANTHROPIC_STRUCTURED_TEMPERATURE = 0.2;

/** Identifies the registered prompt a call renders (src/lib/prompts). */
export interface PromptRef {
  id: string;
  version: number;
  hash: string;
}

export interface StructuredOptions {
  maxTokens?: number;
  ctx?: CallContext;
  signal?: AbortSignal;
  /** Selects the model from the task policy. */
  task?: LlmTask;
  /** Registered prompt, for provenance. Omitted calls are recorded as `adhoc`. */
  prompt?: PromptRef;
}

/** Output reached us but did not fit the schema (after one repair round). */
class StructuredValidationError extends Error {
  constructor(public readonly provider: StructuredProvider, public readonly issues: string[]) {
    super(`${provider} output failed validation: ${issues.join('; ').slice(0, 300)}`);
    this.name = 'StructuredValidationError';
  }
}

let jsonCaller: ((system: string, user: string, maxTokens: number) => Promise<string>) | null = null;

/**
 * Test seam: replaces the providers with a function returning the model's raw
 * JSON text (recorded outputs). The text still goes through JSON.parse, the zod
 * schema and `postValidate`, with no repair round.
 */
export function setLlmJsonCaller(fn: typeof jsonCaller): typeof jsonCaller {
  const prev = jsonCaller;
  jsonCaller = fn;
  return prev;
}

function modelFor(task: LlmTask, provider: StructuredProvider, fallback: string): string {
  return policies[task]?.find((s) => s.provider === provider)?.model ?? fallback;
}

/** Category of a provider failure for provenance. Never carries the provider's message. */
export function errorClassOf(err: unknown): ErrorClass {
  if (err instanceof StructuredValidationError) return 'validation';
  if (err instanceof LlmBudgetExceeded) return 'budget';
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown; message?: unknown };
  if (e?.code === 'LLM_CIRCUIT_OPEN') return 'circuit_open';
  if (e?.code === 'LLM_UNAVAILABLE') return 'unavailable';
  const status = Number(e?.status ?? e?.statusCode);
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server_error';
  const name = String(e?.name ?? '');
  if (name.includes('Timeout') || e?.code === 'UPSTREAM_TIMEOUT') return 'timeout';
  const message = String(e?.message ?? '');
  if (/RESOURCE_EXHAUSTED|Too Many Requests/.test(message)) return 'rate_limited';
  return 'error';
}

type Checked<T> = { ok: true; value: T } | { ok: false; issues: string };

/** zod parse, then the cross-field rule. Never echoes the raw output. */
function check<T>(spec: StructuredSpec<T>, candidate: unknown): Checked<T> {
  const parsed = spec.zod.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  const problem = spec.postValidate?.(parsed.data) ?? null;
  return problem ? { ok: false, issues: `- ${problem}` } : { ok: true, value: parsed.data };
}

interface Run {
  prompts: { system: string; user: string };
  maxTokens: number;
  ctx: CallContext;
  signal: AbortSignal;
  task: LlmTask;
  calls: { n: number };
}

const MAX_TOKENS_CEILING = 16_384;

async function structuredAnthropic<T>(spec: StructuredSpec<T>, run: Run): Promise<{ value: T } & Served> {
  const client = getAnthropicClient();
  if (!client) throw new AppError(503, 'LLM_UNAVAILABLE', 'ANTHROPIC_API_KEY is not set');
  const model = modelFor(run.task, 'anthropic', 'claude-sonnet-4-6');
  const messages: any[] = [{ role: 'user', content: run.prompts.user }];
  let maxTokens = run.maxTokens;
  let raised = false;
  let repaired = false;
  let usage = null as Served['usage'];

  for (;;) {
    run.calls.n++;
    const budget = maxTokens;
    const message = await withLease(
      'anthropic',
      run.ctx,
      estimateTokens({ system: run.prompts.system, user: JSON.stringify(messages) }, budget),
      async () => {
        const res = await client.messages.create(
          {
            model,
            max_tokens: budget,
            temperature: ANTHROPIC_STRUCTURED_TEMPERATURE,
            system: run.prompts.system,
            messages,
            tools: [{ name: spec.name, description: spec.description, input_schema: spec.jsonSchema }],
            tool_choice: { type: 'tool', name: spec.name },
          },
          { signal: run.signal },
        );
        return {
          value: res,
          usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0, model },
        };
      },
      { signal: run.signal, classify: classifyAnthropicError },
    );

    if (message.usage) {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + (Number(message.usage.input_tokens) || 0),
        outputTokens: (usage?.outputTokens ?? 0) + (Number(message.usage.output_tokens) || 0),
      };
    }

    // A truncated tool input is not worth a repair turn at the same budget:
    // raise the budget once, then give up with a specific reason.
    if (message.stop_reason === 'max_tokens') {
      if (!raised && maxTokens < MAX_TOKENS_CEILING) {
        raised = true;
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CEILING);
        logger.warn({ spec: spec.name, maxTokens }, 'Anthropic structured output truncated; retrying with a larger budget');
        continue;
      }
      throw new StructuredValidationError('anthropic', ['output truncated at max_tokens']);
    }

    // The tool_use block may follow a text block; never assume content[0].
    const block = (message.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === spec.name);
    let problem: string;
    if (!block) {
      problem = `- you must call the ${spec.name} tool`;
    } else {
      const checked = check(spec, block.input);
      if (checked.ok) {
        return {
          value: checked.value,
          provider: 'anthropic',
          model,
          attempts: run.calls.n,
          outputSha256: sha256Hex(canonicalJson(block.input)),
          usage,
          params: { temperature: ANTHROPIC_STRUCTURED_TEMPERATURE, maxTokens },
        };
      }
      problem = checked.issues;
    }

    if (repaired) throw new StructuredValidationError('anthropic', [problem]);
    repaired = true;
    messages.push({ role: 'assistant', content: message.content });
    messages.push(
      block
        ? {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: block.id,
              is_error: true,
              content: `Your input failed validation:\n${problem}\nCall ${spec.name} again with corrected input.`,
            }],
          }
        : { role: 'user', content: `You did not call the required tool.\n${problem}\nCall ${spec.name} with valid input.` },
    );
  }
}

async function structuredGemini<T>(spec: StructuredSpec<T>, run: Run): Promise<{ value: T } & Served> {
  if (!isGeminiAvailable()) throw new AppError(503, 'LLM_UNAVAILABLE', 'GEMINI_API_KEY is not set');
  const contents: Content[] = [{ role: 'user', parts: [{ text: run.prompts.user }] }];
  let repaired = false;
  let reported = null as Served['usage'];

  for (;;) {
    run.calls.n++;
    const { text, usage, reportedUsage, attempts } = await callGeminiStructured(
      run.prompts.system,
      contents,
      spec.geminiSchema,
      run.maxTokens,
      { signal: run.signal, ctx: run.ctx },
    );

    run.calls.n += Math.max(0, attempts - 1); // 429 retries are requests too
    if (reportedUsage) {
      reported = {
        inputTokens: (reported?.inputTokens ?? 0) + reportedUsage.inputTokens,
        outputTokens: (reported?.outputTokens ?? 0) + reportedUsage.outputTokens,
      };
    }

    // No fence stripping: responseSchema output must already be plain JSON.
    let problem: string;
    try {
      const checked = check(spec, JSON.parse(text));
      if (checked.ok) {
        return {
          value: checked.value,
          provider: 'gemini',
          model: usage.model ?? GEMINI_MODEL,
          attempts: run.calls.n,
          outputSha256: sha256Hex(text),
          usage: reported,
          params: { temperature: GEMINI_STRUCTURED_TEMPERATURE, maxTokens: run.maxTokens },
        };
      }
      problem = checked.issues;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      problem = `- output is not valid JSON (${err.message.slice(0, 80)})`;
    }

    if (repaired) throw new StructuredValidationError('gemini', [problem]);
    repaired = true;
    contents.push(
      { role: 'model', parts: [{ text }] },
      { role: 'user', parts: [{ text: `Your previous output failed validation:\n${problem}\nReturn the corrected JSON only.` }] },
    );
  }
}

/**
 * Calls the model for output that must satisfy `spec` and returns it typed and
 * validated. Order: Anthropic (forced tool use) → Gemini (responseSchema),
 * each with at most one repair round. A budget rejection never falls back (the
 * budget is global); an open circuit does.
 *
 * Failure: `LLM_STRUCTURED_OUTPUT_FAILED` (422, details `{ provider, issues }`)
 * when a provider answered with output that never validated; otherwise the
 * transport/guard error of the last provider tried.
 */
export async function callLLMStructured<T>(
  spec: StructuredSpec<T>,
  prompts: { system: string; user: string },
  opts: StructuredOptions = {},
): Promise<StructuredResult<T>> {
  const maxTokens = opts.maxTokens ?? 2048;
  const startedAt = performance.now();
  const prompt: PromptRef = opts.prompt ?? { id: 'adhoc', version: 0, hash: sha256Hex(prompts.system) };
  const provenanceOf = (
    served: Served,
    fallbackFrom?: LlmProvenance['fallbackFrom'],
  ): LlmProvenance => ({
    source: 'llm',
    provider: served.provider,
    model: served.model,
    promptId: prompt.id,
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    params: served.params,
    usage: served.usage,
    latencyMs: Math.round(performance.now() - startedAt),
    attempts: served.attempts,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    outputSha256: served.outputSha256,
  });

  if (jsonCaller) {
    const raw = await jsonCaller(prompts.system, prompts.user, maxTokens);
    let checked: Checked<T>;
    try {
      checked = check(spec, JSON.parse(raw));
    } catch {
      checked = { ok: false, issues: '- output is not valid JSON' };
    }
    if (!checked.ok) {
      throw new AppError(422, 'LLM_STRUCTURED_OUTPUT_FAILED', 'LLM output did not satisfy the schema', {
        provider: 'anthropic',
        issues: checked.issues.split('\n'),
      });
    }
    const served: Served = {
      provider: 'anthropic',
      model: 'recorded',
      attempts: 1,
      outputSha256: sha256Hex(raw),
      usage: null,
      params: { temperature: ANTHROPIC_STRUCTURED_TEMPERATURE, maxTokens },
    };
    return { value: checked.value, provider: 'anthropic', model: 'recorded', attempts: 1, provenance: provenanceOf(served) };
  }

  return bulkheads.llm.run(async () => {
    const handle = deadline('llm', opts.signal);
    const run: Run = {
      prompts,
      maxTokens,
      ctx: opts.ctx ?? DEFAULT_CALL_CONTEXT,
      signal: handle.signal,
      task: opts.task ?? 'generic_json',
      calls: { n: 0 },
    };
    let validation: StructuredValidationError | null = null;
    let transport: unknown = null;
    let fallbackFrom: LlmProvenance['fallbackFrom'];

    try {
      const providers: Array<[StructuredProvider, boolean, (s: StructuredSpec<T>, r: Run) => Promise<{ value: T } & Served>]> = [
        ['anthropic', isAnthropicAvailable(), structuredAnthropic],
        ['gemini', isGeminiAvailable(), structuredGemini],
      ];
      for (const [name, available, attempt] of providers) {
        if (!available) continue;
        try {
          const served = await attempt(spec, run);
          const result: StructuredResult<T> = {
            value: served.value,
            provider: served.provider,
            model: served.model,
            attempts: served.attempts,
            provenance: provenanceOf(served, fallbackFrom),
          };
          logger.info(
            { spec: spec.name, provider: result.provider, model: result.model, attempts: result.attempts, purpose: run.ctx.purpose },
            'LLM structured output validated',
          );
          return result;
        } catch (err) {
          if (err instanceof LlmBudgetExceeded) throw err;
          if (run.signal.aborted) throw run.signal.reason;
          fallbackFrom ??= {
            provider: name,
            model: modelFor(run.task, name, name === 'anthropic' ? 'claude-sonnet-4-6' : GEMINI_MODEL),
            errorClass: errorClassOf(err),
          };
          if (err instanceof StructuredValidationError) {
            validation = err;
            logger.warn({ spec: spec.name, provider: name, calls: run.calls.n }, 'LLM structured output failed validation after repair');
          } else {
            transport = err;
            logger.warn({ spec: spec.name, provider: name, err: (err as Error)?.message?.slice(0, 200) }, 'LLM structured call failed');
          }
        }
      }

      if (validation) {
        throw new AppError(422, 'LLM_STRUCTURED_OUTPUT_FAILED', 'LLM output did not satisfy the schema after repair', {
          provider: validation.provider,
          issues: validation.issues,
        });
      }
      if (transport instanceof AppError) throw transport;
      if (transport) throw new AppError(502, 'LLM_CALL_FAILED', `LLM call failed: ${(transport as Error)?.message ?? transport}`);
      throw new AppError(503, 'LLM_UNAVAILABLE', 'No LLM provider is configured');
    } finally {
      handle.cleanup?.();
    }
  }, opts.signal);
}
