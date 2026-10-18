import Anthropic from '@anthropic-ai/sdk';
import { secret, secretEntry } from '../../../config/secrets';
import type { LlmErrorKind, LlmProvider, LlmRequest, ModelSpec, ProviderCompletion } from '../types';
import { LlmError } from '../types';

let cached: Anthropic | null = null;
let cachedVersion = -1;
let cachedBaseUrl = '';

/** Lazy client, rebuilt after key rotation (#145). */
export function getAnthropicClient(baseUrl?: string): Anthropic | null {
  const entry = secretEntry('ANTHROPIC_API_KEY');
  if (!entry.current) return null;
  if (!cached || entry.version !== cachedVersion || (baseUrl ?? '') !== cachedBaseUrl) {
    cached = new Anthropic({ apiKey: entry.current, ...(baseUrl ? { baseURL: baseUrl } : {}) });
    cachedVersion = entry.version;
    cachedBaseUrl = baseUrl ?? '';
  }
  return cached;
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
  available: () => secret('ANTHROPIC_API_KEY') !== '',
  async complete(spec, req): Promise<ProviderCompletion> {
    let message: Anthropic.Message;
    try {
      const client = getAnthropicClient(spec.baseUrl);
      if (!client) throw new LlmError('auth', 'anthropic', 'ANTHROPIC_API_KEY is not set');
      message = await client.messages.create(
        {
          model: spec.model,
          max_tokens: Math.min(req.maxTokens ?? spec.maxTokens, spec.maxTokens),
          temperature: spec.temperature,
          system:
            req.mode === 'json'
              ? `${req.system}\n\nCRITICAL: Your response must be ONLY a valid JSON object. No markdown fences, no preamble, no explanation — pure JSON.`
              : req.system,
          messages: [{ role: 'user', content: req.user }],
        },
        { timeout: spec.timeoutMs, signal: req.signal },
      );
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw mapError(err);
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
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
