import OpenAI from 'openai';
import { config } from '../../../config';
import type { LlmErrorKind, LlmProvider, LlmRequest, ModelSpec, ProviderCompletion } from '../types';
import { LlmError } from '../types';

const cache = new Map<string, OpenAI>();

function clientFor(spec: ModelSpec): OpenAI {
  const key = `${config.OPENAI_API_KEY}|${spec.baseUrl ?? config.OPENAI_BASE_URL}`;
  let client = cache.get(key);
  if (!client) {
    client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      ...(spec.baseUrl || config.OPENAI_BASE_URL
        ? { baseURL: spec.baseUrl || config.OPENAI_BASE_URL }
        : {}),
    });
    cache.set(key, client);
  }
  return client;
}

function mapError(err: unknown): LlmError {
  const status = (err as { status?: number })?.status;
  let kind: LlmErrorKind = 'server';
  if (status === 429) kind = 'rate_limited';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 400) kind = 'invalid_request';
  else if ((err as { name?: string })?.name?.includes('Timeout')) kind = 'timeout';
  return new LlmError(kind, 'openai', `OpenAI-compatible call failed: ${(err as Error)?.message ?? String(err)}`, undefined, [], err);
}

export const openaiProvider: LlmProvider = {
  name: 'openai',
  available: () => Boolean(config.OPENAI_API_KEY),
  async complete(spec, req: LlmRequest): Promise<ProviderCompletion> {
    const json = req.mode === 'json';
    const promptOnlyJson = json && spec.jsonMode === 'prompt';
    try {
      const completion = await clientFor(spec).chat.completions.create(
        {
          model: spec.model,
          temperature: spec.temperature,
          max_tokens: Math.min(req.maxTokens ?? spec.maxTokens, spec.maxTokens),
          messages: [
            { role: 'system', content: promptOnlyJson ? `${req.system}\n\nReturn only a valid JSON object.` : req.system },
            { role: 'user', content: req.user },
          ],
          ...(json && !promptOnlyJson ? { response_format: { type: 'json_object' as const } } : {}),
        },
        { timeout: spec.timeoutMs, signal: req.signal },
      );
      const text = completion.choices?.[0]?.message?.content?.trim();
      if (!text) throw new LlmError('empty', 'openai', 'OpenAI-compatible provider returned an empty response', undefined, []);
      return {
        text,
        usage: {
          inputTokens: completion.usage?.prompt_tokens,
          outputTokens: completion.usage?.completion_tokens,
        },
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw mapError(err);
    }
  },
};
