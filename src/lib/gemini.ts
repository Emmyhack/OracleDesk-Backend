/**
 * Gemini access. The routing policy lives in src/lib/llm/router.ts; this module
 * owns the SDK client, the 429 retry loop and the direct call helpers.
 *
 * Rate limiting, the circuit breaker and token budgets are shared across
 * instances in Redis (src/lib/llm-budget.ts). Every attempt, including each
 * 429 retry, takes a lease, so the shared limiter sees all traffic.
 */
import { GoogleGenerativeAI, type Content, type ModelParams } from '@google/generative-ai';
import { secret, secretEntry } from '../config/secrets';
import { logger } from './logger';
import { deadline, TimeoutError } from './resilience';
import { sleep } from './clock';
import {
  DEFAULT_CALL_CONTEXT,
  withLease,
  type CallContext,
  type Usage,
} from './llm-budget';

// ─── Lazy client, rebuilt after key rotation (#145) ──────────────────────────
let cachedClient: GoogleGenerativeAI | null = null;
let cachedVersion = -1;

export function getGenAI(): GoogleGenerativeAI {
  const entry = secretEntry('GEMINI_API_KEY');
  if (!cachedClient || entry.version !== cachedVersion) {
    cachedClient = new GoogleGenerativeAI(entry.current);
    cachedVersion = entry.version;
  }
  return cachedClient;
}

/** Test seam: installs a mock and keeps it until the real key rotates. */
export function setGenAI(mock: any): any {
  const prev = cachedClient;
  cachedClient = mock;
  cachedVersion = secretEntry('GEMINI_API_KEY').version;
  return prev;
}

/** The slice of a generative model we call. */
export interface GeminiModelLike {
  generateContent(request: any, options?: { signal?: AbortSignal }): Promise<any>;
}
export type GeminiModelFactory = (params: ModelParams) => GeminiModelLike;

let modelFactory: GeminiModelFactory | null = null;

/**
 * Test seam (#65): replaces model construction so recorded provider responses
 * can be replayed without a key or a network. Pass null to restore the SDK.
 */
export function setGeminiModelFactory(factory: GeminiModelFactory | null): GeminiModelFactory | null {
  const prev = modelFactory;
  modelFactory = factory;
  return prev;
}

export function getGeminiModel(params: ModelParams): GeminiModelLike {
  return modelFactory ? modelFactory(params) : (getGenAI().getGenerativeModel(params) as unknown as GeminiModelLike);
}

export function isGeminiAvailable(): boolean {
  return modelFactory !== null || secret('GEMINI_API_KEY') !== '';
}

export const GEMINI_MODEL = 'gemini-2.0-flash';
/** Sampling temperature of schema-constrained calls; recorded in provenance (#66). */
export const GEMINI_STRUCTURED_TEMPERATURE = 0.1;
export { isDailyQuotaError, parseRetryDelayMs };

// Returns true when the error is a daily quota exhaustion (not just RPM).
// Our own timeouts must not trip this.
function isDailyQuotaError(errMsg: string): boolean {
  if (errMsg.includes('UPSTREAM_TIMEOUT') || errMsg.includes('timed out') || errMsg.includes('CLIENT_ABORTED')) {
    return false;
  }
  return (
    errMsg.includes('GenerateRequestsPerDayPerProject') ||
    errMsg.includes('GenerateContentInputTokensPerModelPerMinute-FreeTier') ||
    (errMsg.includes('limit: 0') && errMsg.includes('free_tier'))
  );
}

// ─── Retry delay parser ───────────────────────────────────────────────────────
function parseRetryDelayMs(errorMessage: string): number {
  const floatMatch = errorMessage.match(/[Rr]etry in (\d+(?:\.\d+)?)s/);
  if (floatMatch) {
    return Math.ceil(parseFloat(floatMatch[1])) * 1000 + 3_000;
  }
  const jsonMatch = errorMessage.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  if (jsonMatch) {
    return (parseInt(jsonMatch[1], 10) + 3) * 1000;
  }
  return 30_000; // conservative fallback
}

function is429(errMsg: string): boolean {
  return errMsg.includes('429') || errMsg.includes('Too Many Requests') || errMsg.includes('RESOURCE_EXHAUSTED');
}

// ─── 429 retry loop ───────────────────────────────────────────────────────────

/**
 * Runs `fn` up to 3 times while Gemini answers 429 (per-minute limits). A daily
 * quota error is not retried: it has already opened the shared breaker. Waits
 * that would outlast the deadline raise a TimeoutError instead.
 */
async function withGeminiRetries<T>(
  handle: { signal: AbortSignal; ms: number; remaining(): number },
  fn: () => Promise<T>,
  tally: { attempts: number } = { attempts: 0 },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    tally.attempts = attempt;
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (handle.signal.aborted) throw handle.signal.reason;

      const errMsg: string = err?.message ?? String(err);
      if (!is429(errMsg) || isDailyQuotaError(errMsg) || attempt >= 3) break;

      const delayMs = parseRetryDelayMs(errMsg);
      if (delayMs > handle.remaining()) throw new TimeoutError('llm', handle.ms);

      logger.warn(
        { attempt, retryAfterMs: delayMs },
        `Gemini 429 (RPM) — waiting ${(delayMs / 1000).toFixed(0)}s before retry`,
      );
      await sleep(delayMs, handle.signal);
    }
  }
  logger.error({ err: (lastError as Error)?.message?.slice(0, 300) }, 'Gemini call failed permanently');
  throw lastError;
}

function usageOf(response: any, model: string): Usage {
  const meta = response?.usageMetadata;
  return { inputTokens: meta?.promptTokenCount ?? 0, outputTokens: meta?.candidatesTokenCount ?? 0, model };
}

interface GeminiCall {
  system: string;
  contents: string | Content[];
  maxTokens: number;
  generationConfig: Record<string, unknown>;
  ctx?: CallContext;
  signal?: AbortSignal;
  /** Rough size of the prompt for the reservation. */
  promptChars: number;
}

export interface GeminiResult {
  text: string;
  usage: Usage;
  /** Token counts exactly as reported, or null when the response had no usageMetadata (#66). */
  reportedUsage: { inputTokens: number; outputTokens: number } | null;
  /** HTTP attempts made, 429 retries included (#66). */
  attempts: number;
}

async function runGemini(call: GeminiCall): Promise<GeminiResult> {
  const handle = deadline('llm', call.signal);
  const tally = { attempts: 0 };
  try {
    const result = await withGeminiRetries(handle, () =>
      withLease(
        'gemini',
        call.ctx ?? DEFAULT_CALL_CONTEXT,
        Math.ceil(call.promptChars / 4) + call.maxTokens,
        async () => {
          const model = getGeminiModel({
            model: GEMINI_MODEL,
            systemInstruction: call.system,
            generationConfig: { maxOutputTokens: call.maxTokens, ...call.generationConfig } as any,
          });
          const result = await model.generateContent(call.contents, { signal: handle.signal });
          const text: string = result.response.text();
          const usage = usageOf(result.response, GEMINI_MODEL);
          const meta = result.response?.usageMetadata;
          const reportedUsage = meta
            ? { inputTokens: Number(meta.promptTokenCount ?? 0), outputTokens: Number(meta.candidatesTokenCount ?? 0) }
            : null;
          // Billed even when empty: the tokens were consumed.
          return { value: { text, usage, reportedUsage }, usage };
        },
        {
          signal: handle.signal,
          classify: (err) =>
            isDailyQuotaError((err as Error)?.message ?? '')
              ? { outcome: 'quota', options: { untilMidnight: true, quotaOpenMs: parseRetryDelayMs((err as Error).message) } }
              : { outcome: 'error' },
        },
      ),
      tally,
    );
    if (!result.text || result.text.trim() === '') {
      throw new Error('Gemini returned an empty response');
    }
    return { ...result, attempts: tally.attempts };
  } finally {
    handle.cleanup?.();
  }
}

export async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  opts?: { signal?: AbortSignal; ctx?: CallContext },
): Promise<string> {
  const { text } = await runGemini({
    system: systemPrompt,
    contents: userPrompt,
    maxTokens,
    generationConfig: { temperature: 0.3, topP: 0.95 },
    promptChars: systemPrompt.length + userPrompt.length,
    ctx: opts?.ctx,
    signal: opts?.signal,
  });
  return text;
}

/** JSON-mime output with no schema. Prefer callGeminiStructured. */
export async function callGeminiJSON(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  opts?: { signal?: AbortSignal; ctx?: CallContext },
): Promise<string> {
  const { text } = await runGemini({
    system: systemPrompt,
    contents: userPrompt,
    maxTokens,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, topP: 0.9 },
    promptChars: systemPrompt.length + userPrompt.length,
    ctx: opts?.ctx,
    signal: opts?.signal,
  });
  return text;
}

/**
 * Schema-constrained output (#65): `responseSchema` is the Gemini dialect of a
 * zod-derived schema (src/lib/llm-schema.ts). The text is returned verbatim;
 * the caller JSON-parses and validates it, with no fence stripping.
 */
export async function callGeminiStructured(
  systemPrompt: string,
  contents: Content[],
  responseSchema: Record<string, unknown>,
  maxTokens: number,
  opts?: { signal?: AbortSignal; ctx?: CallContext },
): Promise<GeminiResult> {
  return runGemini({
    system: systemPrompt,
    contents,
    maxTokens,
    generationConfig: { responseMimeType: 'application/json', responseSchema, temperature: GEMINI_STRUCTURED_TEMPERATURE, topP: 0.9 },
    promptChars: systemPrompt.length + JSON.stringify(contents).length,
    ctx: opts?.ctx,
    signal: opts?.signal,
  });
}

export default getGenAI;
