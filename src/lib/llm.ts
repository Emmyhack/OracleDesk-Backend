/**
 * LLM entry point (#157).
 *
 * All calls go through the provider-agnostic router. The default policy
 * reproduces the historical behaviour (Anthropic Claude first, Gemini
 * fallback) while allowing per-task policies via LLM_POLICY / LLM_POLICY_FILE.
 */

import Anthropic from '@anthropic-ai/sdk';
import { secretEntry } from '../config/secrets';
import { logger } from './logger';
import { callGemini, callGeminiJSON } from './gemini';
import { bulkheads, deadline, sleep } from './resilience';

const CLAUDE_MODEL = 'claude-sonnet-4-6';

// ─── Lazy Anthropic client ────────────────────────────────────────────────────
let _anthropic: Anthropic | null = null;
let _anthropicVersion = -1;

export function getAnthropicClient(): Anthropic | null {
  const entry = secretEntry('ANTHROPIC_API_KEY');
  if (!entry.current) return null;
  if (!_anthropic || entry.version !== _anthropicVersion) {
    _anthropic = new Anthropic({ apiKey: entry.current });
    _anthropicVersion = entry.version;
  }
  return _anthropic;
}

// ─── Inter-call interval guard ────────────────────────────────────────────────
let _lastCallAt = 0;
const MIN_INTERVAL_MS = 5_000; // 5 seconds between calls

async function waitForSlot(signal?: AbortSignal): Promise<void> {
  const elapsed = Date.now() - _lastCallAt;
  if (_lastCallAt > 0 && elapsed < MIN_INTERVAL_MS) {
    const wait = MIN_INTERVAL_MS - elapsed;
    logger.debug({ waitMs: wait }, 'LLM call guard: throttling request');
    await sleep(wait, signal);
  }
  _lastCallAt = Date.now();
}

// ─── callLLMJSON — JSON-forced output ─────────────────────────────────────────
// Tries Anthropic Claude first. Falls back to Gemini automatically.
// Returns a clean JSON string ready for JSON.parse().
export async function callLLMJSON(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  return bulkheads.llm.run(async () => {
    const handle = deadline('llm', opts?.signal);
    try {
      await waitForSlot(handle.signal);

      const anthropic = getAnthropicClient();

      if (anthropic) {
        try {
          const message = await anthropic.messages.create(
            {
              model: CLAUDE_MODEL,
              max_tokens: maxTokens,
              temperature: 0.2,
              system:
                systemPrompt +
                '\n\nCRITICAL: Your response must be ONLY a valid JSON object. ' +
                'No markdown fences, no preamble, no explanation — pure JSON.',
              messages: [{ role: 'user', content: userPrompt }],
            },
            {
              signal: handle.signal,
              timeout: handle.ms,
            },
          );

          const block = message.content[0];
          if (block.type !== 'text' || !block.text.trim()) {
            throw new Error('Anthropic returned an empty response');
          }

          const cleaned = block.text
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

          logger.debug({ model: CLAUDE_MODEL }, 'LLM call served by Anthropic Claude');
          return cleaned;
        } catch (err: any) {
          // If caller aborted or deadline reached, do NOT fall back to Gemini
          if (opts?.signal?.aborted || handle.signal.aborted) {
            throw handle.signal.reason;
          }

          logger.warn(
            { err: err?.message?.slice(0, 200) },
            'Anthropic Claude failed — falling back to Gemini',
          );
        }
      } else {
        logger.debug('ANTHROPIC_API_KEY not set — routing directly to Gemini');
      }

      logger.debug('LLM call served by Gemini');
      return await callGeminiJSON(systemPrompt, userPrompt, maxTokens, { signal: handle.signal });
    } finally {
      handle.cleanup?.();
    }
  }, opts?.signal);
}

/** Backwards-compatible plain-text wrapper. Never requests a JSON MIME type. */
export async function callLLMText(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  return bulkheads.llm.run(async () => {
    const handle = deadline('llm', opts?.signal);
    try {
      await waitForSlot(handle.signal);

      const anthropic = getAnthropicClient();

      if (anthropic) {
        try {
          const message = await anthropic.messages.create(
            {
              model: CLAUDE_MODEL,
              max_tokens: maxTokens,
              temperature: 0.4,
              system: systemPrompt,
              messages: [{ role: 'user', content: userPrompt }],
            },
            {
              signal: handle.signal,
              timeout: handle.ms,
            },
          );

          const block = message.content[0];
          if (block.type !== 'text' || !block.text.trim()) {
            throw new Error('Anthropic returned an empty response');
          }
          return block.text.trim();
        } catch (err: any) {
          if (opts?.signal?.aborted || handle.signal.aborted) {
            throw handle.signal.reason;
          }

          logger.warn(
            { err: err?.message?.slice(0, 200) },
            'Anthropic Claude text call failed — falling back to Gemini',
          );
        }
      }

      return await callGemini(systemPrompt, userPrompt, maxTokens, { signal: handle.signal });
    } finally {
      handle.cleanup?.();
    }
  }, opts?.signal);
}
