import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../../config';
import type { LlmErrorKind, LlmProvider, LlmRequest, ModelSpec, ProviderCompletion } from '../types';
import { LlmError } from '../types';

const cache = new Map<string, GoogleGenerativeAI>();

function clientFor(): GoogleGenerativeAI {
  let client = cache.get('default');
  if (!client) {
    client = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    cache.set('default', client);
  }
  return client;
}

export function isDailyQuotaError(errMsg: string): boolean {
  return (
    errMsg.includes('GenerateRequestsPerDayPerProject') ||
    errMsg.includes('GenerateContentInputTokensPerModelPerMinute-FreeTier') ||
    (errMsg.includes('limit: 0') && errMsg.includes('free_tier'))
  );
}

export function parseRetryDelayMs(errorMessage: string): number {
  const floatMatch = errorMessage.match(/[Rr]etry in (\d+(?:\.\d+)?)s/);
  if (floatMatch) return Math.ceil(parseFloat(floatMatch[1])) * 1000 + 3_000;
  const jsonMatch = errorMessage.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  if (jsonMatch) return (parseInt(jsonMatch[1], 10) + 3) * 1000;
  return 30_000;
}

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
  available: () => Boolean(config.GEMINI_API_KEY),
  async complete(spec, req: LlmRequest): Promise<ProviderCompletion> {
    try {
      const model = clientFor().getGenerativeModel({
        model: spec.model,
        systemInstruction: req.system,
        generationConfig: {
          // Text mode must never request JSON; this is the correctness bug the
          // router replaces (the old text path called callGeminiJSON).
          ...(req.mode === 'json' ? { responseMimeType: 'application/json' as const } : {}),
          maxOutputTokens: Math.min(req.maxTokens ?? spec.maxTokens, spec.maxTokens),
          temperature: spec.temperature,
          topP: req.mode === 'json' ? 0.9 : 0.95,
        },
      });
      const result = await model.generateContent(req.user);
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
      if (err instanceof LlmError) throw err;
      throw mapError(err);
    }
  },
};
