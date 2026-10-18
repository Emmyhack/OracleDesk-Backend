import type { CallContext } from '../llm-budget';

export type LlmTask =
  | 'market_generation'
  | 'hedge_conditions'
  | 'forecasting'
  | 'attestation'
  | 'dispute_review'
  | 'generic_json'
  | 'generic_text';

export type OutputMode = 'text' | 'json';

export type LlmErrorKind =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth'
  | 'invalid_request'
  | 'timeout'
  | 'server'
  | 'content_filtered'
  | 'empty'
  | 'parse';

export interface ModelSpec {
  provider: 'anthropic' | 'gemini' | 'openai';
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  baseUrl?: string;
  /** OpenAI-compatible servers that reject response_format can use prompt-only JSON. */
  jsonMode?: 'native' | 'prompt';
  /** Additional attempts on the same spec after a short rate limit. Default 1. */
  retries?: number;
}

export interface LlmRequest {
  task: LlmTask;
  system: string;
  user: string;
  mode: OutputMode;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Purpose and priority for the shared budget (#71). Defaults to a cron call. */
  ctx?: CallContext;
}

export interface Attempt {
  provider: string;
  model: string;
  kind?: LlmErrorKind;
  message?: string;
  latencyMs: number;
  retryAfterMs?: number;
}

export interface LlmResult {
  text: string;
  provenance: {
    task: LlmTask;
    provider: string;
    model: string;
    attempts: Attempt[];
    latencyMs: number;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
}

export interface ProviderCompletion {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LlmProvider {
  readonly name: ModelSpec['provider'];
  available(): boolean;
  complete(spec: ModelSpec, req: LlmRequest): Promise<ProviderCompletion>;
}

export class LlmError extends Error {
  public readonly cause?: unknown;
  constructor(
    public readonly kind: LlmErrorKind,
    public readonly provider: string,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly attempts: Attempt[] = [],
    cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
    this.cause = cause;
  }
}
