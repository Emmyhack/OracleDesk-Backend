import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../config';
import type { LlmErrorKind, LlmProvider, LlmRequest, ModelSpec, ProviderCompletion } from '../types';
import { LlmError } from '../types';

const cache = new Map<string, Anthropic>();

function clientFor(spec: ModelSpec): Anthropic {
  const key = `${config.ANTHROPIC_API_KEY}|${spec.baseUrl ?? ''}`;
  let client = cache.get(key);
  if (!client) {
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}) });
    cache.set(key, client);
  }
  return client;
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
  available: () => Boolean(config.ANTHROPIC_API_KEY),
  async complete(spec, req): Promise<ProviderCompletion> {
    let message: Anthropic.Message;
    try {
      message = await clientFor(spec).messages.create(
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
