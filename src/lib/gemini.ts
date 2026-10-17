/**
 * Compatibility shim over the Gemini provider (#157).
 *
 * The routing, health and retry policy now live in src/lib/llm/router.ts. This
 * module is kept so existing imports (and the generated default client export)
 * continue to work.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { secret, secretEntry } from '../config/secrets';
import { logger } from './logger';
import { deadline, sleep, TimeoutError } from './resilience';

// ─── Lazy client, rebuilt after key rotation (#145) ──────────────────────────
let cachedClient: GoogleGenerativeAI | null = null;
let cachedVersion = -1;

export function getGenAI(): GoogleGenerativeAI {
  const entry = secretEntry('GEMINI_API_KEY');
  if (!cachedClient || entry.version !== cachedVersion) {
    cachedClient = new GoogleGenerativeAI(entry.current);
    cachedVersion = entry.version;
  }
  return cachedClient;
}

/** Test seam: installs a mock and keeps it until the real key rotates. */
export function setGenAI(mock: any): any {
  const prev = cachedClient;
  cachedClient = mock;
  cachedVersion = secretEntry('GEMINI_API_KEY').version;
  return prev;
}

export const GEMINI_MODEL = 'gemini-2.0-flash';
export { isDailyQuotaError, parseRetryDelayMs };

// ─── Per-call interval guard ──────────────────────────────────────────────────
// The ingestion cron (every 15 min) and POST /markets/generate can fire at
// nearly the same time. Without a guard they both call Gemini within the same
// second, doubling RPM consumption and burning through quota twice as fast.
// A 4-second minimum interval between calls is enough to prevent this overlap.
let _lastCallAt = 0;
const MIN_CALL_INTERVAL_MS = 4_000;

async function waitForCallSlot(signal?: AbortSignal): Promise<void> {
  const elapsed = Date.now() - _lastCallAt;
  if (_lastCallAt > 0 && elapsed < MIN_CALL_INTERVAL_MS) {
    const wait = MIN_CALL_INTERVAL_MS - elapsed;
    logger.debug({ waitMs: wait }, 'Gemini call guard: throttling request');
    await sleep(wait, signal);
  }
  _lastCallAt = Date.now();
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────
// When Gemini returns "limit: 0" or a daily quota exhaustion error, retrying
// is pointless — the quota won't reset until midnight UTC. The circuit breaker
// records this state and fast-fails all subsequent calls for QUOTA_COOLDOWN_MS
// so the app doesn't hammer a wall every 15 minutes.
let _quotaExhaustedUntil = 0;
const QUOTA_COOLDOWN_MS  = 60 * 60 * 1000; // 1 hour

function isQuotaExhausted(): boolean {
  return Date.now() < _quotaExhaustedUntil;
}

/** Read-only breaker state for the admin status endpoint. */
export function geminiBreakerState(): { open: boolean; until: string | null } {
  return isQuotaExhausted()
    ? { open: true, until: new Date(_quotaExhaustedUntil).toISOString() }
    : { open: false, until: null };
}

function markQuotaExhausted(): void {
  _quotaExhaustedUntil = Date.now() + QUOTA_COOLDOWN_MS;
  logger.error(
    { cooldownUntil: new Date(_quotaExhaustedUntil).toISOString() },
    'Gemini daily quota exhausted — circuit breaker open. Calls will be skipped for 1 hour.',
  );
}

// Returns true when the error is a daily quota exhaustion (not just RPM)
// Our own timeouts must not trip this.
function isDailyQuotaError(errMsg: string): boolean {
  if (errMsg.includes('UPSTREAM_TIMEOUT') || errMsg.includes('timed out') || errMsg.includes('CLIENT_ABORTED')) {
    return false;
  }
  return (
    errMsg.includes('GenerateRequestsPerDayPerProject') ||
    errMsg.includes('GenerateContentInputTokensPerModelPerMinute-FreeTier') ||
    (errMsg.includes('limit: 0') && errMsg.includes('free_tier'))
  );
}

// ─── Retry delay parser ───────────────────────────────────────────────────────
function parseRetryDelayMs(errorMessage: string): number {
  const floatMatch = errorMessage.match(/[Rr]etry in (\d+(?:\.\d+)?)s/);
  if (floatMatch) {
    return Math.ceil(parseFloat(floatMatch[1])) * 1000 + 3_000;
  }
  const jsonMatch = errorMessage.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  if (jsonMatch) {
    return (parseInt(jsonMatch[1], 10) + 3) * 1000;
  }
  return 30_000; // conservative fallback
}

export async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  if (isQuotaExhausted()) {
    throw new Error(
      `Gemini quota circuit breaker is open until ${new Date(_quotaExhaustedUntil).toISOString()}. ` +
      'Add billing to your Google AI account or wait for the quota to reset.',
    );
  }

  const handle = deadline('llm', opts?.signal);

  try {
    await waitForCallSlot(handle.signal);

    const model = getGenAI().getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: systemPrompt,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.3,
        topP: 0.95,
      },
    });

    const result = await (model as any).generateContent(userPrompt, { signal: handle.signal });
    const text   = result.response.text();

    if (!text || text.trim() === '') {
      throw new Error('Gemini returned an empty text response');
    }

    return text;
  } catch (err: any) {
    logger.error({ err: err?.message }, 'Gemini text call failed');
    throw err;
  } finally {
    handle.cleanup?.();
  }
}

// ─── callGeminiJSON — JSON-forced output ──────────────────────────────────────
export async function callGeminiJSON(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  if (isQuotaExhausted()) {
    throw new Error(
      `Gemini quota circuit breaker is open until ${new Date(_quotaExhaustedUntil).toISOString()}. ` +
      'Add billing to your Google AI account or wait for the quota to reset.',
    );
  }

  const handle = deadline('llm', opts?.signal);

  try {
    await waitForCallSlot(handle.signal);

    let lastError: any;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const model = getGenAI().getGenerativeModel({
          model: GEMINI_MODEL,
          systemInstruction: systemPrompt,
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens:  maxTokens,
            temperature:      0.1,
            topP:             0.90,
          },
        });

        const result = await (model as any).generateContent(userPrompt, { signal: handle.signal });
        const text   = result.response.text();

        if (!text || text.trim() === '') {
          throw new Error('Gemini returned empty JSON response');
        }

        const cleaned = text
          .trim()
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();

        return cleaned;

      } catch (err: any) {
        lastError = err;

        if (handle.signal.aborted) {
          throw handle.signal.reason;
        }

        const errMsg: string = err?.message ?? String(err);
        const is429 = errMsg.includes('429') ||
                      errMsg.includes('Too Many Requests') ||
                      errMsg.includes('RESOURCE_EXHAUSTED');

        if (!is429) {
          break;
        }

        if (isDailyQuotaError(errMsg)) {
          markQuotaExhausted();
          break;
        }

        if (attempt >= 3) break;

        const delayMs = parseRetryDelayMs(errMsg);
        if (delayMs > handle.remaining()) {
          throw new TimeoutError('llm', handle.ms);
        }

        logger.warn(
          { attempt, retryAfterMs: delayMs },
          `Gemini 429 (RPM) — waiting ${(delayMs / 1000).toFixed(0)}s before retry`,
        );
        await sleep(delayMs, handle.signal);
      }
    }

    logger.error(
      { err: lastError?.message?.slice(0, 300) },
      'Gemini JSON call failed permanently',
    );

    throw lastError;
  } finally {
    handle.cleanup?.();
  }
}

export default getGenAI;
