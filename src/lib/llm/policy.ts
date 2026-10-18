import { readFileSync } from 'fs';
import { z } from 'zod';
import { config } from '../../config';
import type { LlmTask, ModelSpec } from './types';

export type LlmPolicies = Record<LlmTask, ModelSpec[]>;

const TASKS = [
  'market_generation',
  'hedge_conditions',
  'forecasting',
  'attestation',
  'dispute_review',
  'generic_json',
  'generic_text',
] as const;

const modelSpecSchema = z.object({
  provider: z.enum(['anthropic', 'gemini', 'openai']),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  baseUrl: z.string().url().optional(),
  jsonMode: z.enum(['native', 'prompt']).optional(),
  retries: z.number().int().min(0).max(5).optional(),
});

const policySchema = z.partialRecord(
  z.enum(TASKS),
  z.array(modelSpecSchema).min(1),
);

const anthropic = (model = 'claude-sonnet-4-6', temperature = 0.2, maxTokens = 4096): ModelSpec => ({
  provider: 'anthropic',
  model,
  temperature,
  maxTokens,
  timeoutMs: 60_000,
});

const gemini = (temperature = 0.1, maxTokens = 4096): ModelSpec => ({
  provider: 'gemini',
  model: 'gemini-2.0-flash',
  temperature,
  maxTokens,
  timeoutMs: 60_000,
});

/** Reproduces the pre-router behaviour: Claude first, Gemini as fallback. */
export const DEFAULT_POLICIES: LlmPolicies = {
  market_generation: [anthropic('claude-sonnet-4-6', 0.2, 4096), gemini(0.1, 4096)],
  hedge_conditions: [anthropic('claude-sonnet-4-6', 0.2, 1024), gemini(0.1, 1024)],
  forecasting: [anthropic('claude-sonnet-4-6', 0.2, 2048), gemini(0.1, 2048)],
  attestation: [anthropic('claude-sonnet-4-6', 0.1, 1024), gemini(0.1, 1024)],
  // #92: a different primary model from attestation, so one model's blind spot is not shared.
  dispute_review: [gemini(0, 1024), anthropic('claude-sonnet-4-6', 0, 1024)],
  generic_json: [anthropic('claude-sonnet-4-6', 0.2, 2048), gemini(0.1, 2048)],
  generic_text: [anthropic('claude-sonnet-4-6', 0.4, 2048), gemini(0.3, 2048)],
};

function sourceJson(): string | null {
  if (config.LLM_POLICY_FILE) {
    return readFileSync(config.LLM_POLICY_FILE, 'utf8');
  }
  return config.LLM_POLICY || null;
}

/** Parses and validates LLM_POLICY / LLM_POLICY_FILE, naming the bad task. */
export function loadPolicies(raw = sourceJson()): LlmPolicies {
  if (!raw) return DEFAULT_POLICIES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM_POLICY is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = policySchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const task = String(issue.path[0] ?? '(root)');
      return `  ${task}: ${issue.message}`;
    });
    throw new Error(`Invalid LLM_POLICY:\n${lines.join('\n')}`);
  }
  // A policy may override only some tasks; the rest keep the built-in default.
  return { ...DEFAULT_POLICIES, ...(result.data as Partial<LlmPolicies>) };
}

export const policies: LlmPolicies = loadPolicies();
