import { nowMs, sleep as clockSleep } from '../clock';
import { logger } from '../logger';
import type {
  Attempt,
  LlmErrorKind,
  LlmProvider,
  LlmRequest,
  LlmResult,
  ModelSpec,
} from './types';
import { LlmError } from './types';
import type { LlmPolicies } from './policy';
import { LlmBudgetExceeded } from '../llm-budget';

export interface ProviderHealth {
  state: 'healthy' | 'cooling' | 'open';
  consecutiveFailures: number;
  until?: number;
  lastError?: LlmErrorKind;
}

export interface Router {
  complete(req: LlmRequest): Promise<LlmResult>;
  health(): Record<string, ProviderHealth>;
}

export interface RouterOptions {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (attempt: Attempt) => void;
  retryInlineMaxMs?: number;
  quotaCooldownMs?: number;
  failureCooldownMs?: number;
  failureThreshold?: number;
}

const RETRY_INLINE_MAX_MS = 5_000;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 60_000;
const FAILURE_THRESHOLD = 3;

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function asLlmError(err: unknown, provider: string): LlmError {
  if (err instanceof LlmError) return err;
  const message = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;
  let kind: LlmErrorKind = 'server';
  if (status === 429) kind = 'rate_limited';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 400) kind = 'invalid_request';
  else if ((err as { name?: string })?.name?.includes('Timeout')) kind = 'timeout';
  return new LlmError(kind, provider, message, undefined, [], err);
}

export function createRouter(
  policies: LlmPolicies,
  providers: Partial<Record<ModelSpec['provider'], LlmProvider>>,
  options: RouterOptions = {},
): Router {
  // Defaults read the shared clock (#72), so a test clock removes real waiting.
  const clock = options.clock ?? nowMs;
  const sleep = options.sleep ?? ((ms: number) => clockSleep(ms));
  const retryInlineMaxMs = options.retryInlineMaxMs ?? RETRY_INLINE_MAX_MS;
  const quotaCooldownMs = options.quotaCooldownMs ?? QUOTA_COOLDOWN_MS;
  const failureCooldownMs = options.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
  const failureThreshold = options.failureThreshold ?? FAILURE_THRESHOLD;

  const health = new Map<string, ProviderHealth>();
  const stateOf = (provider: string): ProviderHealth => {
    const current = health.get(provider);
    if (!current) return { state: 'healthy', consecutiveFailures: 0 };
    if (current.until !== undefined && current.until <= clock() && current.state !== 'healthy') {
      return { state: 'healthy', consecutiveFailures: current.consecutiveFailures };
    }
    return current;
  };
  const setHealth = (provider: string, next: ProviderHealth) => health.set(provider, next);

  return {
    health() {
      return Object.fromEntries(Object.keys(providers).map((name) => [name, stateOf(name)]));
    },

    async complete(req) {
      const policy = policies[req.task];
      if (!policy || policy.length === 0) {
        throw new LlmError('invalid_request', 'router', `No LLM policy configured for task "${req.task}"`);
      }

      const attempts: Attempt[] = [];
      const startedAt = clock();
      let lastError: LlmError | null = null;
      let previousProvider: string | null = null;

      for (const spec of policy) {
        const provider = providers[spec.provider];
        if (!provider || !provider.available()) {
          // Missing key is a configuration skip, not a provider failure.
          continue;
        }

        const current = stateOf(spec.provider);
        if ((current.state === 'cooling' || current.state === 'open') && (current.until ?? 0) > clock()) {
          previousProvider = spec.provider;
          continue;
        }

        if (previousProvider && previousProvider !== spec.provider) {
          logger.warn(
            { task: req.task, from: previousProvider, to: spec.provider, kind: lastError?.kind },
            'LLM failover',
          );
        }

        const maxAttempts = 1 + Math.max(0, spec.retries ?? 1);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const attemptStarted = clock();
          try {
            const completion = await provider.complete(spec, req);
            const text = req.mode === 'json' ? stripFences(completion.text) : completion.text.trim();
            if (req.mode === 'json') {
              try {
                JSON.parse(text);
              } catch {
                throw new LlmError('parse', spec.provider, 'LLM returned non-parseable JSON', undefined, [], undefined);
              }
            }
            const succeeded: Attempt = {
              provider: spec.provider,
              model: spec.model,
              latencyMs: clock() - attemptStarted,
            };
            attempts.push(succeeded);
            options.onAttempt?.(succeeded);
            setHealth(spec.provider, { state: 'healthy', consecutiveFailures: 0 });
            return {
              text,
              provenance: {
                task: req.task,
                provider: spec.provider,
                model: spec.model,
                attempts,
                latencyMs: clock() - startedAt,
                usage: completion.usage,
              },
            };
          } catch (err) {
            // The budget is global: another provider would draw on the same one.
            if (err instanceof LlmBudgetExceeded) throw err;
            const normalized = asLlmError(err, spec.provider);
            lastError = normalized;
            const failed: Attempt = {
              provider: spec.provider,
              model: spec.model,
              kind: normalized.kind,
              message: normalized.message.slice(0, 200),
              latencyMs: clock() - attemptStarted,
              retryAfterMs: normalized.retryAfterMs,
            };
            attempts.push(failed);
            options.onAttempt?.(failed);
            const currentHealth = stateOf(spec.provider);

            if (normalized.kind === 'rate_limited') {
              const retryAfter = normalized.retryAfterMs ?? 30_000;
              if (retryAfter <= retryInlineMaxMs && attempt < maxAttempts) {
                logger.warn(
                  { provider: spec.provider, attempt, retryAfterMs: retryAfter },
                  'LLM rate limited — retrying inline',
                );
                await sleep(retryAfter);
                continue;
              }
              setHealth(spec.provider, {
                state: 'cooling',
                consecutiveFailures: currentHealth.consecutiveFailures + 1,
                until: clock() + Math.max(retryAfter, 1_000),
                lastError: normalized.kind,
              });
              break;
            }

            if (normalized.kind === 'quota_exhausted') {
              setHealth(spec.provider, {
                state: 'open',
                consecutiveFailures: currentHealth.consecutiveFailures + 1,
                until: clock() + quotaCooldownMs,
                lastError: normalized.kind,
              });
              break;
            }

            if (normalized.kind === 'server' || normalized.kind === 'timeout') {
              const failures = currentHealth.consecutiveFailures + 1;
              setHealth(spec.provider, {
                state: failures >= failureThreshold ? 'cooling' : 'healthy',
                consecutiveFailures: failures,
                until: failures >= failureThreshold ? clock() + failureCooldownMs : undefined,
                lastError: normalized.kind,
              });
              break;
            }

            if (normalized.kind === 'auth' || normalized.kind === 'invalid_request') {
              logger.error(
                { provider: spec.provider, kind: normalized.kind, task: req.task },
                'LLM provider rejected the request — failing over',
              );
              setHealth(spec.provider, {
                state: currentHealth.state,
                consecutiveFailures: currentHealth.consecutiveFailures + 1,
                until: currentHealth.until,
                lastError: normalized.kind,
              });
              break;
            }

            // empty / parse / content_filtered: try the next spec.
            setHealth(spec.provider, {
              state: currentHealth.state,
              consecutiveFailures: currentHealth.consecutiveFailures + 1,
              until: currentHealth.until,
              lastError: normalized.kind,
            });
            break;
          }
        }
        previousProvider = spec.provider;
      }

      throw new LlmError(
        lastError?.kind ?? 'server',
        lastError?.provider ?? 'router',
        lastError?.message ?? `All LLM providers are unavailable for task "${req.task}"`,
        lastError?.retryAfterMs,
        attempts,
        lastError ?? undefined,
      );
    },
  };
}
