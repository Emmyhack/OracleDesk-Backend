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
import { callGeminiStructured, isGeminiAvailable, setGeminiModelFactory, GEMINI_MODEL } from './gemini';
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

export interface StructuredResult<T> {
  value: T;
  provider: StructuredProvider;
  model: string;
  /** Provider calls made, repairs included. */
  attempts: number;
}

export interface StructuredOptions {
  maxTokens?: number;
  ctx?: CallContext;
  signal?: AbortSignal;
  /** Selects the model from the task policy. */
  task?: LlmTask;
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

async function structuredAnthropic<T>(spec: StructuredSpec<T>, run: Run): Promise<StructuredResult<T>> {
  const client = getAnthropicClient();
  if (!client) throw new AppError(503, 'LLM_UNAVAILABLE', 'ANTHROPIC_API_KEY is not set');
  const model = modelFor(run.task, 'anthropic', 'claude-sonnet-4-6');
  const messages: any[] = [{ role: 'user', content: run.prompts.user }];
  let maxTokens = run.maxTokens;
  let raised = false;
  let repaired = false;

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
            temperature: 0.2,
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
        return { value: checked.value, provider: 'anthropic', model, attempts: run.calls.n };
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

async function structuredGemini<T>(spec: StructuredSpec<T>, run: Run): Promise<StructuredResult<T>> {
  if (!isGeminiAvailable()) throw new AppError(503, 'LLM_UNAVAILABLE', 'GEMINI_API_KEY is not set');
  const contents: Content[] = [{ role: 'user', parts: [{ text: run.prompts.user }] }];
  let repaired = false;

  for (;;) {
    run.calls.n++;
    const { text, usage } = await callGeminiStructured(
      run.prompts.system,
      contents,
      spec.geminiSchema,
      run.maxTokens,
      { signal: run.signal, ctx: run.ctx },
    );

    // No fence stripping: responseSchema output must already be plain JSON.
    let problem: string;
    try {
      const checked = check(spec, JSON.parse(text));
      if (checked.ok) {
        return { value: checked.value, provider: 'gemini', model: usage.model ?? GEMINI_MODEL, attempts: run.calls.n };
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
    return { value: checked.value, provider: 'anthropic', model: 'recorded', attempts: 1 };
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

    try {
      const providers: Array<[StructuredProvider, boolean, (s: StructuredSpec<T>, r: Run) => Promise<StructuredResult<T>>]> = [
        ['anthropic', isAnthropicAvailable(), structuredAnthropic],
        ['gemini', isGeminiAvailable(), structuredGemini],
      ];
      for (const [name, available, attempt] of providers) {
        if (!available) continue;
        try {
          const result = await attempt(spec, run);
          logger.info(
            { spec: spec.name, provider: result.provider, model: result.model, attempts: result.attempts, purpose: run.ctx.purpose },
            'LLM structured output validated',
          );
          return result;
        } catch (err) {
          if (err instanceof LlmBudgetExceeded) throw err;
          if (run.signal.aborted) throw run.signal.reason;
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
