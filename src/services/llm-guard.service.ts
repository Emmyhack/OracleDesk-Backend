/**
 * Prompt-injection defences for market generation (#70).
 *
 * Headlines, article descriptions, GDELT URLs and previously generated market
 * questions are attacker-controllable text, and what the model returns can
 * move real money (the treasury seeds every accepted proposal). The layers:
 *
 *   1. sanitise at ingestion (sanitizeSignal): Unicode NFKC, control /
 *      zero-width / bidi removal, whitespace collapse, length caps, URLs moved
 *      out of the text, instruction-like text flagged;
 *   2. quarantine flagged signals (partitionSignals): never sent to the model;
 *   3. delimit what is sent (renderUntrustedBlock): one JSON line per signal in
 *      a block with a random nonce, delimiter look-alikes escaped;
 *   4. say so in the system prompt (done by the callers);
 *   5. check the model's answer deterministically (checkProposal): grounded in
 *      signals that were really sent, probability / expiry / oracle / content
 *      policy.
 *
 * Everything here is pure and side-effect free. Logs built from these results
 * carry reason codes and hashes, never the raw attacker text.
 */
import { randomBytes } from 'node:crypto';
import type { MarketProposal, RawSignal } from '../types';
import { ALLOWED_ORACLES, meaningfulTokens } from './market-policy';

export interface SanitizedSignal extends RawSignal {
  /** Citable id (n1, f1, m1, e1…) assigned when the signal is sent to a model. */
  id?: string;
  url?: string;
  sanitizedFlags: string[];
}

export type SanitizeFlag = 'stripped_control' | 'had_url' | 'truncated' | 'instruction_like';

export const MAX_TITLE_CHARS = 200;
export const MAX_CONTENT_CHARS = 300;

// Probability policy: extreme prices are the main economic attack, so they are
// rejected rather than clamped.
export const MIN_INITIAL_PROBABILITY = 0.05;
export const MAX_INITIAL_PROBABILITY = 0.95;
export const MIN_EXPIRY_DAYS = 1;
export const MAX_EXPIRY_DAYS = 90;
export const MIN_GROUNDING_TOKEN_OVERLAP = 2;

const URL_RE = /https?:\/\/\S+/gi;

/**
 * Instruction phrasing, not single words: "Markets ignore Fed warning" is a
 * normal headline. Matched after NFKC so full-width look-alikes cannot hide it.
 */
const INSTRUCTION_RE = new RegExp(
  [
    String.raw`\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|every|the|your|my|these|those)\s+)*(?:of\s+)?(?:previous|prior|above|earlier|preceding|system|safety)\s+(?:instructions?|rules?|prompts?|messages?|context|directions?|guidelines?)\b`,
    String.raw`\b(?:ignore|disregard|forget)\s+(?:all|everything)\s+(?:above|before|previous|prior|you\s+(?:were|have\s+been)\s+told)\b`,
    String.raw`\bsystem\s+prompt\b`,
    String.raw`\byou\s+are\s+now\b`,
    String.raw`\bnew\s+(?:instructions?|rules?)\s*:`,
    String.raw`\b(?:output|respond\s+with|return|reply\s+with)\s+(?:only\s+)?(?:the\s+)?(?:following\s+)?(?:json|market_question)\b`,
    String.raw`\b(?:market_question|initial_yes_probability|resolution_oracle|expiry_timestamp|grounding_signal_ids|settlement_currency|minimum_liquidity_usdc|confidence_interval)\b`,
    String.raw`\brequired\s+json\s+structure\b`,
    String.raw`</?\s*(?:untrusted_signals|existing_markets|system|assistant|instructions?)\b`,
  ].join('|'),
  'i',
);

export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_RE.test(text.normalize('NFKC'));
}

export function sanitizeSignalText(
  input: string,
  maxLen: number,
): { text: string; flags: SanitizeFlag[]; urls: string[] } {
  const flags = new Set<SanitizeFlag>();
  let text = String(input ?? '').normalize('NFKC');

  // Line breaks and tabs become spaces first; whatever control or format
  // characters remain (zero-width, bidi overrides, NUL…) are removed.
  text = text.replace(/[\t\n\r\f\v\u2028\u2029]+/g, ' ');
  const stripped = text.replace(/[\p{Cc}\p{Cf}]/gu, '');
  if (stripped.length !== text.length) flags.add('stripped_control');
  text = stripped;

  const urls = text.match(URL_RE) ?? [];
  if (urls.length > 0) {
    flags.add('had_url');
    text = text.replace(URL_RE, ' ');
  }

  text = text.replace(/\s+/gu, ' ').trim();

  const chars = Array.from(text);
  if (chars.length > maxLen) {
    text = chars.slice(0, maxLen).join('').trimEnd();
    flags.add('truncated');
  }

  if (looksLikeInstruction(text)) flags.add('instruction_like');
  return { text, flags: [...flags], urls };
}

const SAFE_TOKEN_RE = /[^A-Za-z0-9_.-]/g;

/**
 * Sanitises one ingested signal. Idempotent, so already-clean cached rows pass
 * through unchanged. FRED rows are built by our code from numbers; they are
 * sanitised like the rest but never flagged `instruction_like`.
 */
export function sanitizeSignal(
  raw: RawSignal & { url?: string; id?: string; sanitizedFlags?: string[] },
): SanitizedSignal {
  const source = String(raw.source ?? '').normalize('NFKC').replace(SAFE_TOKEN_RE, '').slice(0, 40).toUpperCase() || 'UNKNOWN';
  const title = sanitizeSignalText(raw.title, MAX_TITLE_CHARS);
  const content = sanitizeSignalText(raw.content, MAX_CONTENT_CHARS);
  const category = String(raw.category ?? '').replace(SAFE_TOKEN_RE, '').slice(0, 40);

  // Flags from an earlier pass are kept, so re-sanitising a cached row is lossless.
  const flags = new Set<SanitizeFlag>([...title.flags, ...content.flags, ...((raw.sanitizedFlags ?? []) as SanitizeFlag[])]);
  const urls = [...title.urls, ...content.urls];
  const url = raw.url || urls[0];
  if (url) flags.add('had_url');
  if (source === 'FRED') flags.delete('instruction_like');

  return {
    source,
    title: title.text,
    content: content.text,
    publishedAt: raw.publishedAt,
    relevanceScore: raw.relevanceScore,
    category,
    ...(url ? { url } : {}),
    ...(raw.id ? { id: raw.id } : {}),
    sanitizedFlags: [...flags],
  };
}

/** Flagged signals never reach the model. FRED is exempt (see sanitizeSignal). */
export function partitionSignals<T extends SanitizedSignal>(signals: T[]): { clean: T[]; quarantined: T[] } {
  const clean: T[] = [];
  const quarantined: T[] = [];
  for (const s of signals) (s.sanitizedFlags.includes('instruction_like') ? quarantined : clean).push(s);
  return { clean, quarantined };
}

function escapeLookalikes(text: string, label: string): string {
  const names = new Set([label, 'untrusted_signals', 'existing_markets', 'system', 'assistant']);
  return text.replace(new RegExp(`<\\s*/?\\s*(?=${[...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'), '‹');
}

/**
 * Renders signals as data: one JSON object per line inside a block whose tag
 * carries a fresh random nonce (never derived from content, so an attacker
 * cannot precompute the closing tag). JSON.stringify escapes quotes and line
 * breaks; look-alikes of the delimiter inside the text become `‹label`.
 */
export function renderUntrustedBlock(signals: SanitizedSignal[], label: string, fixedNonce?: string): string {
  // `fixedNonce` exists only so the offline evaluation (#67) can hash a prompt
  // reproducibly; production callers always get a fresh random nonce.
  const nonce = fixedNonce ?? randomBytes(6).toString('hex');
  const lines = signals.map((s, i) =>
    JSON.stringify({
      id: s.id ?? `${label.charAt(0)}${i + 1}`,
      source: escapeLookalikes(s.source, label),
      title: escapeLookalikes(s.title, label),
      content: escapeLookalikes(s.content, label),
    }),
  );
  return [`<${label} nonce="${nonce}">`, ...lines, `</${label} nonce="${nonce}">`].join('\n');
}

/**
 * Renders a small JSON record (a question document, #75) as one line of data
 * inside a nonce-delimited block. Every string is sanitised like signal text
 * and delimiter look-alikes are escaped. Returns null when any string looks
 * like an instruction: such a record is quarantined, not sent.
 */
export function renderUntrustedRecord(
  record: Record<string, unknown>,
  label: string,
  fixedNonce?: string,
  maxStringChars = MAX_CONTENT_CHARS,
): string | null {
  let suspicious = false;
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const { text, flags } = sanitizeSignalText(value, maxStringChars);
      if (flags.includes('instruction_like')) suspicious = true;
      return escapeLookalikes(text, label);
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  const body = JSON.stringify(clean(record));
  if (suspicious) return null;
  const nonce = fixedNonce ?? randomBytes(6).toString('hex');
  return [`<${label} nonce="${nonce}">`, body, `</${label} nonce="${nonce}">`].join('\n');
}

// ─── Post-generation policy ───────────────────────────────────────────────────

export type GuardReason =
  | 'UNGROUNDED'
  | 'PROBABILITY_OUT_OF_POLICY'
  | 'EXPIRY_OUT_OF_RANGE'
  | 'ORACLE_NOT_ALLOWED'
  | 'BANNED_TOPIC'
  | 'URL_IN_QUESTION'
  | 'INSTRUCTION_ECHO'
  | 'NON_ASCII_CONTROL';

export type GuardResult =
  | { ok: true }
  | { ok: false; reasons: GuardReason[]; detail: Record<string, unknown> };

/** Frozen on purpose: changing the policy is a code change that gets reviewed. */
export const BANNED_TOPIC_PATTERNS: readonly RegExp[] = Object.freeze([
  // self-harm
  /\b(?:suicid\w*|self[- ]?harm|kill\s+(?:him|her|them|my|your)self|overdose)\b/i,
  // death markets
  /\b(?:will|would|does|did)\b[^?]{0,80}\b(?:die|dies|dead|pass(?:es)?\s+away|be\s+(?:killed|murdered|assassinated|shot))\b/i,
  /\b(?:death|assassination|murder)\s+of\b/i,
  // private individuals
  /\b(?:my|your|his|her|their)\s+(?:neighbou?r|boss|ex|wife|husband|girlfriend|boyfriend|coworker|classmate|teacher|landlord)\b/i,
  /\bprivate\s+(?:citizen|individual|person)\b/i,
  /\b(?:doxx?|home\s+address|social\s+security)\b/i,
]);

const HANDLE_RE = /(?:^|[\s(])@[A-Za-z0-9_]{2,}/;
const URLISH_RE = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|io|xyz|info|example)\b/i;
const FENCE_RE = /```|`/;
const CONTROL_RE = /[\p{Cc}\p{Cf}]/u;

const DAY_SECONDS = 86_400;

export function checkProposal(
  p: MarketProposal,
  signals: SanitizedSignal[],
  now: Date,
): GuardResult {
  const reasons = new Set<GuardReason>();
  const detail: Record<string, unknown> = {};

  // Grounding: cited ids must be signals that were actually sent, and at least
  // one of them must share meaningful words with the question.
  const byId = new Map(signals.filter((s) => s.id).map((s) => [s.id as string, s]));
  const cited = Array.isArray(p.grounding_signal_ids) ? p.grounding_signal_ids : [];
  const unknown = cited.filter((id) => !byId.has(id));
  const questionTokens = new Set(meaningfulTokens(p.market_question));
  const overlaps = cited
    .map((id) => byId.get(id))
    .filter((s): s is SanitizedSignal => Boolean(s))
    .map((s) => meaningfulTokens(`${s.title} ${s.content}`).filter((t) => questionTokens.has(t)).length);
  const bestOverlap = overlaps.length > 0 ? Math.max(...overlaps) : 0;
  if (cited.length === 0 || unknown.length > 0 || bestOverlap < MIN_GROUNDING_TOKEN_OVERLAP) {
    reasons.add('UNGROUNDED');
    detail.grounding = { cited: cited.length, unknownIds: unknown.length, bestTokenOverlap: bestOverlap };
  }

  if (
    !Number.isFinite(p.initial_yes_probability) ||
    p.initial_yes_probability < MIN_INITIAL_PROBABILITY ||
    p.initial_yes_probability > MAX_INITIAL_PROBABILITY
  ) {
    reasons.add('PROBABILITY_OUT_OF_POLICY');
    detail.probability = p.initial_yes_probability;
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expiry = p.expiry_timestamp;
  if (
    !Number.isFinite(expiry) ||
    expiry < nowSeconds + MIN_EXPIRY_DAYS * DAY_SECONDS ||
    expiry > nowSeconds + MAX_EXPIRY_DAYS * DAY_SECONDS
  ) {
    reasons.add('EXPIRY_OUT_OF_RANGE');
    detail.expiryDays = Number.isFinite(expiry) ? Math.round(((expiry - nowSeconds) / DAY_SECONDS) * 10) / 10 : null;
  }

  if (!ALLOWED_ORACLES.includes(p.resolution_oracle)) {
    reasons.add('ORACLE_NOT_ALLOWED');
    detail.oracleLength = String(p.resolution_oracle ?? '').length;
  }

  const prose = [p.market_question, p.reasoning, p.resolution_oracle].map((t) => String(t ?? ''));
  const text = prose.join('\n');
  if (BANNED_TOPIC_PATTERNS.some((re) => re.test(text))) reasons.add('BANNED_TOPIC');
  if (prose.some((t) => URLISH_RE.test(t) || HANDLE_RE.test(t) || FENCE_RE.test(t))) reasons.add('URL_IN_QUESTION');
  if (looksLikeInstruction(prose[0]) || looksLikeInstruction(prose[1])) reasons.add('INSTRUCTION_ECHO');
  if (prose.some((t) => CONTROL_RE.test(t))) reasons.add('NON_ASCII_CONTROL');

  return reasons.size === 0 ? { ok: true } : { ok: false, reasons: [...reasons], detail };
}
