import { getGeminiModel, isDailyQuotaError, isGeminiAvailable, parseRetryDelayMs } from '../../gemini';
import { AppError } from '../../../middlewares/error.middleware';
import { estimateTokens, withLease } from '../../llm-budget';
import type { LlmErrorKind, LlmProvider, LlmRequest, ModelSpec, ProviderCompletion } from '../types';
import { LlmError } from '../types';

function mapError(err: unknown): LlmError {
  const message = (err as Error)?.message ?? String(err);
  if (isDailyQuotaError(message)) {
    return new LlmError('quota_exhausted', 'gemini', message, 60 * 60 * 1000, [], err);
  }
  if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('Too Many Requests')) {
    return new LlmError('rate_limited', 'gemini', message, parseRetryDelayMs(message), [], err);
  }
  if (message.includes('API_KEY_INVALID') || message.includes('401') || message.includes('403')) {
    return new LlmError('auth', 'gemini', message, undefined, [], err);
  }
  if (message.toLowerCase().includes('timeout')) {
    return new LlmError('timeout', 'gemini', message, undefined, [], err);
  }
  let kind: LlmErrorKind = 'server';
  try {
    const parsed = JSON.parse(message.slice(message.indexOf('{'))); // best-effort JSON error body
    if (parsed?.error?.code === 400) kind = 'invalid_request';
  } catch {
    // keep server
  }
  return new LlmError(kind, 'gemini', message, undefined, [], err);
}

export const geminiProvider: LlmProvider = {
  name: 'gemini',
  available: isGeminiAvailable,
  async complete(spec, req: LlmRequest): Promise<ProviderCompletion> {
    try {
      const maxTokens = Math.min(req.maxTokens ?? spec.maxTokens, spec.maxTokens);
      const result = await withLease(
        'gemini',
        req.ctx,
        estimateTokens(req, maxTokens),
        async () => {
          const model = getGeminiModel({
            model: spec.model,
            systemInstruction: req.system,
            generationConfig: {
              // Text mode must never request JSON; this is the correctness bug the
              // router replaces (the old text path called callGeminiJSON).
              ...(req.mode === 'json' ? { responseMimeType: 'application/json' as const } : {}),
              maxOutputTokens: maxTokens,
              temperature: spec.temperature,
              topP: req.mode === 'json' ? 0.9 : 0.95,
            },
          });
          const res = await model.generateContent(req.user, { signal: req.signal });
          const meta = res.response.usageMetadata;
          return {
            value: res,
            usage: { inputTokens: meta?.promptTokenCount ?? 0, outputTokens: meta?.candidatesTokenCount ?? 0, model: spec.model },
          };
        },
        {
          signal: req.signal,
          classify: (err) =>
            isDailyQuotaError((err as Error)?.message ?? '')
              ? { outcome: 'quota', options: { untilMidnight: true, quotaOpenMs: parseRetryDelayMs((err as Error).message) } }
              : { outcome: 'error' },
        },
      );
      const text = result.response.text()?.trim();
      if (!text) throw new LlmError('empty', 'gemini', 'Gemini returned an empty response', undefined, []);
      const usage = result.response.usageMetadata;
      return {
        text,
        usage: {
          inputTokens: usage?.promptTokenCount,
          outputTokens: usage?.candidatesTokenCount,
        },
      };
    } catch (err) {
      if (err instanceof LlmError || err instanceof AppError) throw err;
      throw mapError(err);
    }
  },
};
