import Anthropic from '@anthropic-ai/sdk';
import { secret, secretEntry } from '../../../config/secrets';
import { AppError } from '../../../middlewares/error.middleware';
import type { LlmErrorKind, LlmProvider, LlmRequest, ModelSpec, ProviderCompletion } from '../types';
import { LlmError } from '../types';
import { estimateTokens, withLease, type Classified } from '../../llm-budget';

/** The slice of the SDK we use; tests inject a fake through setAnthropicClient. */
export interface AnthropicLike {
  messages: { create(body: any, options?: any): Promise<any> };
}

let cached: Anthropic | null = null;
let cachedVersion = -1;
let cachedBaseUrl = '';
let override: AnthropicLike | null = null;

/** Test seam: route every Anthropic call to `client` (null restores the real SDK). */
export function setAnthropicClient(client: AnthropicLike | null): AnthropicLike | null {
  const prev = override;
  override = client;
  return prev;
}

export function isAnthropicAvailable(): boolean {
  return override !== null || secret('ANTHROPIC_API_KEY') !== '';
}

/** Lazy client, rebuilt after key rotation (#145). */
export function getAnthropicClient(baseUrl?: string): AnthropicLike | null {
  if (override) return override;
  const entry = secretEntry('ANTHROPIC_API_KEY');
  if (!entry.current) return null;
  if (!cached || entry.version !== cachedVersion || (baseUrl ?? '') !== cachedBaseUrl) {
    // maxRetries: 0 so the shared limiter sees every HTTP attempt (#71).
    cached = new Anthropic({ apiKey: entry.current, maxRetries: 0, ...(baseUrl ? { baseURL: baseUrl } : {}) });
    cachedVersion = entry.version;
    cachedBaseUrl = baseUrl ?? '';
  }
  return cached;
}

/** Billing/credit failures will not heal on retry: open the breaker at once. */
export function classifyAnthropicError(err: unknown): Classified {
  const message = (err as Error)?.message ?? '';
  if (/credit balance|billing|quota|insufficient/i.test(message)) return { outcome: 'quota' };
  return { outcome: 'error' };
}

function mapError(err: unknown): LlmError {
  const status = (err as { status?: number })?.status;
  const name = (err as { name?: string })?.name ?? '';
  let kind: LlmErrorKind = 'server';
  let retryAfterMs: number | undefined;
  if (status === 429) {
    kind = 'rate_limited';
    const header = (err as { headers?: Record<string, string> })?.headers?.['retry-after'];
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
    }
  } else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 400) kind = 'invalid_request';
  else if (name.includes('Timeout') || name.includes('APIConnectionTimeout')) kind = 'timeout';
  else if (status === 529 || (status !== undefined && status >= 500)) kind = 'server';
  return new LlmError(kind, 'anthropic', `Anthropic call failed: ${(err as Error)?.message ?? String(err)}`, retryAfterMs, [], err);
}

export const anthropicProvider: LlmProvider = {
  name: 'anthropic',
  available: isAnthropicAvailable,
  async complete(spec, req): Promise<ProviderCompletion> {
    let message: any;
    const maxTokens = Math.min(req.maxTokens ?? spec.maxTokens, spec.maxTokens);
    try {
      const client = getAnthropicClient(spec.baseUrl);
      if (!client) throw new LlmError('auth', 'anthropic', 'ANTHROPIC_API_KEY is not set');
      message = await withLease(
        'anthropic',
        req.ctx,
        estimateTokens(req, maxTokens),
        async () => {
          const res = await client.messages.create(
            {
              model: spec.model,
              max_tokens: maxTokens,
              temperature: spec.temperature,
              system:
                req.mode === 'json'
                  ? `${req.system}\n\nCRITICAL: Your response must be ONLY a valid JSON object. No markdown fences, no preamble, no explanation — pure JSON.`
                  : req.system,
              messages: [{ role: 'user', content: req.user }],
            },
            { timeout: spec.timeoutMs, signal: req.signal },
          );
          return {
            value: res,
            usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0, model: spec.model },
          };
        },
        { signal: req.signal, classify: classifyAnthropicError },
      );
    } catch (err) {
      if (err instanceof LlmError || err instanceof AppError) throw err;
      throw mapError(err);
    }

    const text = message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('')
      .trim();
    if (!text) throw new LlmError('empty', 'anthropic', 'Anthropic returned an empty response', undefined, []);
    if (req.mode === 'json' && message.stop_reason === 'max_tokens') {
      throw new LlmError('parse', 'anthropic', 'Anthropic response was truncated at max_tokens', undefined, []);
    }
    return {
      text,
      usage: {
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
      },
    };
  },
};
