/**
 * Shared LLM guards (#71): rate limiting, circuit breaking and daily budgets
 * that hold across every API instance and worker, because the state lives in
 * Redis (see llm-budget-store.ts for the atomic scripts).
 *
 *   const lease = await acquire('anthropic', ctx, estimate);
 *   ... call the provider ...
 *   await record(lease, usage, 'ok');
 *
 * `withLease` wraps that pair. Reservations are released in `record`, also on
 * errors and responses without usage metadata; a lease that is never recorded
 * is reclaimed by the next `acquire` once its TTL passes.
 *
 * Budgets are counted per UTC day, independent of checkDailyDrawdown's local
 * midnight. Cost is an estimate from LLM_PRICES, not an invoice.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { AppError } from '../middlewares/error.middleware';
import { logger } from './logger';
import { getRedis } from './redis';
import { nowMs, sleep as clockSleep } from './clock';
import {
  MemoryGuardStore,
  RedisGuardStore,
  type AcquireResult,
  type BreakerState,
  type CallOutcome,
  type LlmGuardStore,
  type Priority,
  type Provider,
  type UsageSnapshot,
} from './llm-budget-store';

export type { BreakerState, CallOutcome, LlmGuardStore, Priority, Provider, UsageSnapshot };
export { MemoryGuardStore, RedisGuardStore };

export interface CallContext {
  /** e.g. market_generation, trace_hedge, admin_generation */
  purpose: string;
  priority: Priority;
}

export const DEFAULT_CALL_CONTEXT: CallContext = { purpose: 'unspecified', priority: 'cron' };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface Lease {
  id: string;
  provider: Provider;
  ctx: CallContext;
  day: string;
  estimate: number;
  probe: boolean;
  /** Acquired from the in-process fallback limiter (Redis down, fail-open). */
  local: boolean;
}

export class LlmBudgetExceeded extends AppError {
  constructor(details: Record<string, unknown> = {}) {
    super(429, 'LLM_BUDGET_EXCEEDED', 'Daily LLM budget exhausted', details);
    this.name = 'LlmBudgetExceeded';
  }
}

export class LlmCircuitOpen extends AppError {
  constructor(details: Record<string, unknown> = {}) {
    super(503, 'LLM_CIRCUIT_OPEN', 'LLM provider circuit is open', details);
    this.name = 'LlmCircuitOpen';
  }
}

/**
 * Estimated prices in USD micro-units (1e-6 USD) per 1K tokens. These are
 * ESTIMATES kept in code for budgeting; check the providers' pricing pages and
 * update when models or prices change. Unknown models are priced like the
 * most expensive entry so the budget errs on the side of stopping.
 */
export const LLM_PRICES: Record<string, { inputPer1k: number; outputPer1k: number }> = {
  'claude-sonnet-4-6': { inputPer1k: 3_000, outputPer1k: 15_000 },
  'gemini-2.0-flash': { inputPer1k: 100, outputPer1k: 400 },
};
const FALLBACK_PRICE = { inputPer1k: 3_000, outputPer1k: 15_000 };

export function estimateCostMicros(usage: Usage | null): number {
  if (!usage) return 0;
  const price = LLM_PRICES[usage.model] ?? FALLBACK_PRICE;
  return Math.ceil((usage.inputTokens * price.inputPer1k + usage.outputTokens * price.outputPer1k) / 1000);
}

/** Tokens to reserve before a call: ~4 chars per input token plus the output cap. */
export function estimateTokens(prompts: { system: string; user: string }, maxTokens: number): number {
  return Math.ceil((prompts.system.length + prompts.user.length) / 4) + maxTokens;
}

// ─── Settings (from config; overridable in tests) ─────────────────────────────

export interface GuardSettings {
  tokenBudget: number;
  costBudgetMicros: number;
  reservePct: number;
  rpm: Record<Provider, number>;
  failureThreshold: number;
  openMs: number;
  failMode: 'closed' | 'open';
  /** Max time acquire() waits for the bucket before giving up. */
  maxWaitMs: number;
  leaseTtlMs: number;
  probeTtlMs: number;
}

function defaultSettings(): GuardSettings {
  return {
    tokenBudget: config.LLM_DAILY_TOKEN_BUDGET,
    costBudgetMicros: config.LLM_DAILY_COST_BUDGET_MICROS,
    reservePct: config.LLM_ADMIN_RESERVE_PCT,
    rpm: { anthropic: config.LLM_ANTHROPIC_RPM, gemini: config.LLM_GEMINI_RPM },
    failureThreshold: config.LLM_BREAKER_FAILURE_THRESHOLD,
    openMs: config.LLM_BREAKER_OPEN_MS,
    failMode: config.LLM_REDIS_FAIL_MODE,
    maxWaitMs: 30_000,
    leaseTtlMs: config.TIMEOUT_LLM_MS * 2,
    probeTtlMs: config.TIMEOUT_LLM_MS,
  };
}

let overrides: Partial<GuardSettings> = {};
export function settings(): GuardSettings {
  return { ...defaultSettings(), ...overrides };
}
/** Test seam. Pass `{}` to restore config-derived settings. */
export function setLlmGuardSettings(next: Partial<GuardSettings>): void {
  overrides = next;
}

// ─── Store ────────────────────────────────────────────────────────────────────

let store: LlmGuardStore | null = null;
export function getLlmGuardStore(): LlmGuardStore {
  return (store ??= new RedisGuardStore(getRedis));
}
/** Test seam. Returns the previous store. */
export function setLlmGuardStore(next: LlmGuardStore | null): LlmGuardStore | null {
  const prev = store;
  store = next;
  return prev;
}

// ─── Redis-down fallback ──────────────────────────────────────────────────────

let localStore = new MemoryGuardStore();
let lastStoreWarnAt = 0;
function warnStoreDown(err: unknown, failMode: string): void {
  const now = Date.now();
  if (now - lastStoreWarnAt < 60_000) return;
  lastStoreWarnAt = now;
  logger.warn({ err: (err as Error)?.message, failMode }, 'LLM guard store unavailable');
}
export function resetLocalLlmLimiter(): void {
  localStore = new MemoryGuardStore();
  lastStoreWarnAt = 0;
}

let waitFn: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => clockSleep(ms, signal);
/** Test seam for the RATE_LIMITED wait. */
export function setLlmWait(fn: typeof waitFn | null): void {
  waitFn = fn ?? ((ms, signal) => clockSleep(ms, signal));
}

// ─── acquire / record ─────────────────────────────────────────────────────────

export async function acquire(
  provider: Provider,
  ctx: CallContext,
  estimatedTokens: number,
  opts: { signal?: AbortSignal } = {},
): Promise<Lease> {
  const s = settings();
  const leaseId = randomUUID();
  const started = nowMs();
  let local = false;
  let active: LlmGuardStore = getLlmGuardStore();

  for (;;) {
    let res: AcquireResult;
    try {
      res = await active.acquire({
        provider,
        leaseId,
        priority: ctx.priority,
        estimate: estimatedTokens,
        rpm: s.rpm[provider],
        tokenBudget: s.tokenBudget,
        costBudgetMicros: s.costBudgetMicros,
        reservePct: s.reservePct,
        leaseTtlMs: s.leaseTtlMs,
        probeTtlMs: s.probeTtlMs,
      });
    } catch (err) {
      if (active === localStore) throw err;
      warnStoreDown(err, s.failMode);
      if (s.failMode === 'closed') {
        throw new LlmCircuitOpen({ provider, reason: 'GUARD_STORE_UNAVAILABLE' });
      }
      active = localStore;
      local = true;
      continue;
    }

    if (res.ok) {
      return { id: leaseId, provider, ctx, day: res.day, estimate: estimatedTokens, probe: res.probe, local };
    }
    if (res.reason === 'BUDGET_EXCEEDED') {
      throw new LlmBudgetExceeded({ provider, purpose: ctx.purpose, priority: ctx.priority, retryAfterMs: res.retryAfterMs });
    }
    if (res.reason === 'CIRCUIT_OPEN') {
      throw new LlmCircuitOpen({ provider, retryAfterMs: res.retryAfterMs });
    }
    // RATE_LIMITED: wait for a token, with jitter, for at most maxWaitMs.
    const wait = res.retryAfterMs + Math.floor(Math.random() * Math.min(250, res.retryAfterMs + 1));
    if (nowMs() - started + wait > s.maxWaitMs) {
      throw new AppError(429, 'LLM_RATE_LIMITED', `LLM rate limit for ${provider} not available within ${s.maxWaitMs}ms`, {
        provider,
        retryAfterMs: res.retryAfterMs,
      });
    }
    logger.debug({ provider, waitMs: wait }, 'LLM rate limit: waiting for a token');
    await waitFn(wait, opts.signal);
  }
}

export interface RecordOptions {
  /** For outcome 'quota': keep the breaker open at least this long. */
  quotaOpenMs?: number;
  /** For outcome 'quota': also hold it until the next UTC midnight. */
  untilMidnight?: boolean;
}

export async function record(
  lease: Lease,
  usage: Usage | null,
  outcome: CallOutcome,
  opts: RecordOptions = {},
): Promise<void> {
  const s = settings();
  const costMicros = estimateCostMicros(usage);
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;

  logger.info(
    {
      provider: lease.provider,
      model: usage?.model ?? null,
      purpose: lease.ctx.purpose,
      priority: lease.ctx.priority,
      inputTokens,
      outputTokens,
      estimatedCostMicros: costMicros,
      outcome,
    },
    'LLM call recorded',
  );

  try {
    await (lease.local ? localStore : getLlmGuardStore()).record({
      provider: lease.provider,
      leaseId: lease.id,
      day: lease.day,
      estimate: lease.estimate,
      probe: lease.probe,
      inputTokens,
      outputTokens,
      costMicros,
      outcome,
      failureThreshold: s.failureThreshold,
      openMs: opts.quotaOpenMs ?? s.openMs,
      openUntilMidnight: opts.untilMidnight ?? false,
    });
  } catch (err) {
    // The reservation expires on its own; never fail the caller's response.
    warnStoreDown(err, s.failMode);
  }
}

export interface Classified {
  outcome: 'error' | 'quota';
  options?: RecordOptions;
}

/**
 * Runs `fn` between acquire and record. `fn` returns the value plus the usage
 * to bill; a throw records 'error' (or 'quota' via `classify`) and rethrows.
 */
export async function withLease<T>(
  provider: Provider,
  ctx: CallContext | undefined,
  estimatedTokens: number,
  fn: (lease: Lease) => Promise<{ value: T; usage: Usage | null }>,
  opts: { signal?: AbortSignal; classify?: (err: unknown) => Classified } = {},
): Promise<T> {
  const lease = await acquire(provider, ctx ?? DEFAULT_CALL_CONTEXT, estimatedTokens, { signal: opts.signal });
  let result: { value: T; usage: Usage | null };
  try {
    result = await fn(lease);
  } catch (err) {
    const c = opts.classify?.(err) ?? { outcome: 'error' as const };
    await record(lease, null, c.outcome, c.options);
    throw err;
  }
  await record(lease, result.usage, 'ok');
  return result.value;
}

// ─── Visibility ───────────────────────────────────────────────────────────────

export async function breakerState(provider: Provider): Promise<BreakerState> {
  try {
    return await getLlmGuardStore().breakerState(provider);
  } catch {
    return 'closed';
  }
}

export async function getLlmUsage(): Promise<UsageSnapshot & { tokenBudget: number; costBudgetMicros: number }> {
  const s = settings();
  const snap = await getLlmGuardStore().usage();
  return { ...snap, tokenBudget: s.tokenBudget, costBudgetMicros: s.costBudgetMicros };
}

/** True the first time `name` is claimed today (UTC); used to log once per day. */
export async function claimDailyOnce(name: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    return await getLlmGuardStore().setOnce(`${name}:${day}`, 48 * 3600);
  } catch {
    return true; // can't dedupe without the store; log rather than hide it
  }
}
