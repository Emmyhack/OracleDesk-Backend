/**
 * LLM provenance (#66): what produced a decision, recorded next to the
 * decision. Everything here is plain JSON (strings, numbers, booleans, nested
 * objects, no Date, no undefined) because it is embedded in the trace payload
 * before canonicalisation and pinning.
 *
 * Only hashes and categories are recorded. Raw prompts, raw outputs and
 * provider error messages can contain third-party text or request ids and are
 * never stored here.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { config } from '../../config';
import { assertCanonicalSafe } from '../../utils/hash.util';

export const PROVENANCE_SCHEMA = 'oracledesk.trace.provenance/1';

/** A bounded set, so a provider message can never leak through it. */
export type ErrorClass =
  | 'validation'
  | 'rate_limited'
  | 'timeout'
  | 'auth'
  | 'circuit_open'
  | 'budget'
  | 'unavailable'
  | 'server_error'
  | 'error';

/** A model produced the output. */
export interface LlmProvenance {
  source: 'llm';
  provider: 'anthropic' | 'gemini';
  model: string;
  promptId: string;
  promptVersion: number;
  promptHash: string;
  params: { temperature: number; maxTokens: number };
  /** Summed over the serving provider's calls; null when the SDK reported none. */
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Wall time of the whole call, fallback and repairs included. */
  latencyMs: number;
  /** Provider requests made, repairs and 429 retries included. */
  attempts: number;
  /** Set when another provider failed first. `errorClass` is a category only. */
  fallbackFrom?: { provider: 'anthropic' | 'gemini'; model: string; errorClass: ErrorClass };
  /** sha256 of the raw model output (canonical JSON of a tool input). */
  outputSha256: string;
}

/** No model produced the output: a hard-coded safe default was used. */
export interface DefaultProvenance {
  source: 'default';
  promptId: string;
  promptVersion: number;
  reason: 'LLM_FAILED' | 'LLM_BUDGET_EXCEEDED';
}

export type ProvenanceEntry = LlmProvenance | DefaultProvenance;

export interface GeneratorInfo {
  service: 'oracledesk-backend';
  version: string;
  commit?: string;
}

export interface TraceProvenance {
  schema: typeof PROVENANCE_SCHEMA;
  llm: ProvenanceEntry[];
  generator: GeneratorInfo;
}

let cachedVersion: string | null = null;

/** package.json version, found by walking up (src/, dist/ and dist-tests/ differ). */
function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'oracledesk-backend' && pkg.version) return (cachedVersion = pkg.version);
      } catch { /* keep walking */ }
    }
    dir = dirname(dir);
  }
  return (cachedVersion = 'unknown');
}

export function generatorInfo(): GeneratorInfo {
  const commit = config.GIT_SHA;
  return { service: 'oracledesk-backend', version: packageVersion(), ...(commit ? { commit } : {}) };
}

/** The block embedded in the trace payload and stored in ReasoningTrace.provenance. */
export function buildTraceProvenance(entries: ProvenanceEntry[]): TraceProvenance {
  const block: TraceProvenance = { schema: PROVENANCE_SCHEMA, llm: entries, generator: generatorInfo() };
  assertCanonicalSafe(block, 'provenance');
  return block;
}

export interface ProvenanceSummary {
  providers: string[];
  promptVersions: string[];
  source: 'llm' | 'default' | 'mixed';
}

/** Reduced view for previews. Null for traces that predate provenance. */
export function summarizeProvenance(block: unknown): ProvenanceSummary | null {
  if (!block || typeof block !== 'object') return null;
  const entries = (block as { llm?: unknown }).llm;
  if (!Array.isArray(entries)) return null;
  const providers = new Set<string>();
  const versions = new Set<string>();
  let llm = 0;
  let dflt = 0;
  for (const e of entries as Array<Record<string, unknown>>) {
    if (e?.source === 'llm') {
      llm++;
      if (typeof e.provider === 'string') providers.add(e.provider);
    } else if (e?.source === 'default') dflt++;
    if (typeof e?.promptId === 'string') versions.add(`${e.promptId}@${e.promptVersion}`);
  }
  return {
    providers: [...providers].sort(),
    promptVersions: [...versions].sort(),
    source: llm > 0 && dflt > 0 ? 'mixed' : dflt > 0 ? 'default' : 'llm',
  };
}
