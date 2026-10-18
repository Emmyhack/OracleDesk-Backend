/**
 * LLM entry point (#157).
 *
 * All calls go through the provider-agnostic router. The default policy
 * reproduces the historical behaviour (Anthropic Claude first, Gemini
 * fallback) while allowing per-task policies via LLM_POLICY / LLM_POLICY_FILE.
 * Every call runs inside the `llm` bulkhead and honours the shared deadline.
 */
import { createRouter } from './llm/router';
import { policies } from './llm/policy';
import { anthropicProvider, geminiProvider, openaiProvider } from './llm/providers';
import { getAnthropicClient } from './llm/providers/anthropic';
import type { LlmRequest, LlmResult, LlmTask } from './llm/types';
import { bulkheads, deadline } from './resilience';

export const llmRouter = createRouter(policies, {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  openai: openaiProvider,
});

export type { LlmRequest, LlmResult, LlmTask };
export { LlmError } from './llm/types';
export { getAnthropicClient };

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
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const result = await completeLLM({
    task,
    system: systemPrompt,
    user: userPrompt,
    mode: 'json',
    maxTokens,
    signal: opts?.signal,
  });
  return result.text;
}

/** Backwards-compatible plain-text wrapper. Never requests a JSON MIME type. */
export async function callLLMText(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  task: LlmTask = 'generic_text',
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const result = await completeLLM({
    task,
    system: systemPrompt,
    user: userPrompt,
    mode: 'text',
    maxTokens,
    signal: opts?.signal,
  });
  return result.text;
}
