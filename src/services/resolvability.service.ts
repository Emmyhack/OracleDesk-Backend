/**
 * Deterministic resolvability check for generated markets (#74).
 *
 * Under ADR 0001 a market commits on-chain to how it resolves, and the
 * resolver enforces timing strictly: `attest` is rejected before
 * `market.close_time`, `finalize_signers` only after the dispute window. The
 * question text, close time and "resolution source" all come from an LLM, so
 * nothing guarantees they fit together. This module extracts the deadline and
 * measurable from the text with a table-driven grammar (no NLP, no I/O), maps
 * the oracle to an allowlisted source, checks the close time against the
 * source's publication lag, and either repairs the close time within safe
 * bounds or rejects with reason codes.
 *
 * Timeline: event deadline → source publishes (publication lag) → close_time
 * → attestation → dispute window → finalisation. close_time must lie in
 * [deadline + lag, deadline + lag + MAX_POST_EVENT_TRADING_SECS].
 */
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import type { MarketCategory } from '@prisma/client';
import type { MarketProposal } from '../types';
import { MEETINGS, type MeetingBody, type MeetingDef } from './resolvability.calendar';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

/** Trading may continue this long after the answer is public. */
export const MAX_POST_EVENT_TRADING_SECS = 6 * 3600;
/** Time allowed for signers to attest after close. */
export const ATTESTATION_SLA_SECS = 48 * 3600;
/** close + dispute window + SLA must finish within this horizon. */
export const MAX_HORIZON_DAYS = 120;
/** A repaired close is never earlier than this after `now`. */
export const MIN_LEAD_SECS = 24 * 3600;

export type SourceId =
  | 'FRED' | 'BLS' | 'ECB' | 'AP_ELECTIONS' | 'AP_POLITICS' | 'ESPN' | 'BILLBOARD' | 'OPEC' | 'CHAINLINK';

export interface ResolutionSourceDef {
  id: SourceId;
  categories: MarketCategory[];
  /** Seconds after a point-in-time event (a date) until the source shows the answer. */
  publicationLagSecs: number;
  /** Lag after the end of a data period ("for September", "in Q3"); defaults to publicationLagSecs. */
  periodLagSecs?: number;
  /** Lag after a scheduled meeting announcement; defaults to publicationLagSecs. */
  meetingLagSecs?: number;
  /** IANA zone used when the question gives a bare date. */
  timeZone: string;
  /** May contain `{series}` (FRED). */
  urlTemplate?: string;
  /** What a signer checks. */
  instructions: string;
}

const DAY = 86_400;

export const RESOLUTION_SOURCES: Record<SourceId, ResolutionSourceDef> = {
  FRED: {
    id: 'FRED',
    categories: ['FED', 'MACRO'],
    publicationLagSecs: DAY,
    periodLagSecs: 17 * DAY,
    meetingLagSecs: 3600,
    timeZone: 'America/New_York',
    urlTemplate: 'https://fred.stlouisfed.org/series/{series}',
    instructions:
      'Check the FRED series for the measurable. FRED revises series: use the first published value only. For rate decisions the Federal Reserve press release (federalreserve.gov) is authoritative at announcement time.',
  },
  BLS: {
    id: 'BLS',
    categories: ['MACRO'],
    publicationLagSecs: 16 * DAY,
    timeZone: 'America/New_York',
    urlTemplate: 'https://www.bls.gov/news.release/',
    instructions:
      'Use the first release of the BLS news release for the reference period (for example the CPI release). Later revisions do not count.',
  },
  ECB: {
    id: 'ECB',
    categories: ['ECB', 'MACRO'],
    publicationLagSecs: DAY,
    periodLagSecs: 31 * DAY,
    meetingLagSecs: 3600,
    timeZone: 'Europe/Berlin',
    urlTemplate: 'https://www.ecb.europa.eu/press/pr/date/html/index.en.html',
    instructions:
      'Use the ECB monetary policy decision press release or the ECB Data Portal first published value for the reference period. Later revisions do not count.',
  },
  AP_ELECTIONS: {
    id: 'AP_ELECTIONS',
    categories: ['ELECTION', 'POLITICS'],
    publicationLagSecs: 12 * 3600,
    timeZone: 'America/New_York',
    urlTemplate: 'https://apnews.com/hub/election-2026',
    instructions:
      'Resolve on the Associated Press race call or official result. If AP has not called the race at close, do not attest; the market is voided by the guardian.',
  },
  AP_POLITICS: {
    id: 'AP_POLITICS',
    categories: ['POLITICS', 'GEOPOLITICAL', 'ELECTION'],
    publicationLagSecs: 6 * 3600,
    timeZone: 'America/New_York',
    urlTemplate: 'https://apnews.com/politics',
    instructions: 'Resolve on Associated Press reporting of the event. Require the event itself, not a plan or announcement of intent.',
  },
  ESPN: {
    id: 'ESPN',
    categories: ['SPORTS'],
    publicationLagSecs: 3 * 3600,
    timeZone: 'America/New_York',
    urlTemplate: 'https://www.espn.com/',
    instructions: 'Resolve on the final result published by ESPN. Ignore results that are later overturned only if ESPN has not updated them.',
  },
  BILLBOARD: {
    id: 'BILLBOARD',
    categories: ['ENTERTAINMENT'],
    publicationLagSecs: 4 * DAY,
    timeZone: 'America/New_York',
    urlTemplate: 'https://www.billboard.com/charts/',
    instructions: 'Use the Billboard chart dated within the question period, as first published. Chart weeks are published days after they end.',
  },
  OPEC: {
    id: 'OPEC',
    categories: ['MACRO', 'GEOPOLITICAL'],
    publicationLagSecs: 16 * DAY,
    timeZone: 'Europe/Vienna',
    urlTemplate: 'https://www.opec.org/opec_web/en/publications/338.htm',
    instructions: 'Use the OPEC Monthly Oil Market Report (first release) or the official OPEC press release for the measurable.',
  },
  CHAINLINK: {
    id: 'CHAINLINK',
    categories: ['CRYPTO'],
    publicationLagSecs: 60,
    timeZone: 'UTC',
    urlTemplate: 'https://data.chain.link/',
    instructions: 'Use the Chainlink data feed answer at the deadline instant. A price-spec (Reflector) resolution is a separate effort; today signers read the feed.',
  },
};

// ─── Extraction ──────────────────────────────────────────────────────────────

export interface ExtractedDeadline {
  at: Date;
  kind: 'by' | 'on' | 'during-period';
  text: string;
}

export interface ExtractedQuestion {
  deadlines: ExtractedDeadline[];
  comparator?: '>' | '>=' | '<' | '<=' | '=';
  threshold?: { value: number; unit?: string; text: string };
  periodRef?: { kind: 'month' | 'quarter' | 'meeting'; label: string; end: Date };
  subject?: string;
}

export interface ExtractOptions {
  /** Zone for bare dates; default UTC. */
  timeZone?: string;
  /** Which meeting calendar "at its September meeting" refers to. */
  meetingBody?: MeetingBody;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthIndex = (name: string): number => {
  const key = name.toLowerCase().replace('.', '').slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(key));
};

const DATE_RE =
  `(?:\\d{4}-\\d{2}-\\d{2}` +
  `|${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?` +
  `|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+\\d{4})?)`;

interface Ctx {
  now: Date;
  tz: string;
  body?: MeetingBody;
}

interface Built {
  at: Date;
  period?: ExtractedQuestion['periodRef'];
}

/** 23:59:59 local on a calendar day, as a UTC instant. Never adds 86400 s (DST). */
export function endOfLocalDay(year: number, month0: number, day: number, tz: string): Date | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  const probe = new Date(Date.UTC(year, month0, day));
  if (probe.getUTCMonth() !== month0 || probe.getUTCDate() !== day) return null; // Feb 30 etc.
  const local = dayjs.tz(`${year}-${pad(month0 + 1)}-${pad(day)} 23:59:59`, 'YYYY-MM-DD HH:mm:ss', tz);
  return local.isValid() ? local.toDate() : null;
}

const lastDayOfMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** Calendar year in `tz` for an instant. */
const yearIn = (d: Date, tz: string) => dayjs(d).tz(tz).year();

/** A day with no year resolves to its next occurrence at or after now. */
function resolveYearless(month0: number, day: number, ctx: Ctx): Date | null {
  const y = yearIn(ctx.now, ctx.tz);
  for (const year of [y, y + 1, y + 4]) {
    const end = endOfLocalDay(year, month0, day, ctx.tz);
    if (end && end.getTime() >= ctx.now.getTime()) return end;
  }
  return null;
}

/** Parses one DATE_RE match into end-of-day (source zone). `dayOffset` handles "before". */
function parseDate(text: string, ctx: Ctx, dayOffset = 0): Date | null {
  let year: number | undefined;
  let month0: number;
  let day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (iso) {
    year = Number(iso[1]); month0 = Number(iso[2]) - 1; day = Number(iso[3]);
  } else {
    const mdy = new RegExp(`^(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$`, 'i').exec(text.trim());
    const dmy = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?$`, 'i').exec(text.trim());
    if (mdy) { month0 = monthIndex(mdy[1]); day = Number(mdy[2]); year = mdy[3] ? Number(mdy[3]) : undefined; }
    else if (dmy) { day = Number(dmy[1]); month0 = monthIndex(dmy[2]); year = dmy[3] ? Number(dmy[3]) : undefined; }
    else return null;
  }
  if (month0 < 0) return null;
  let end: Date | null;
  if (year !== undefined) {
    if (dayOffset !== 0) {
      const shifted = new Date(Date.UTC(year, month0, day + dayOffset));
      return endOfLocalDay(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), ctx.tz);
    }
    end = endOfLocalDay(year, month0, day, ctx.tz);
  } else {
    end = resolveYearless(month0, day, ctx);
    if (end && dayOffset !== 0) {
      const local = dayjs(end).tz(ctx.tz);
      const shifted = new Date(Date.UTC(local.year(), local.month(), local.date() + dayOffset));
      return endOfLocalDay(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), ctx.tz);
    }
  }
  return end;
}

/** End of a month (year optional: next occurrence). */
function monthEnd(month0: number, yearText: string | undefined, ctx: Ctx): Date | null {
  if (yearText) return endOfLocalDay(Number(yearText), month0, lastDayOfMonth(Number(yearText), month0), ctx.tz);
  const y = yearIn(ctx.now, ctx.tz);
  for (const year of [y, y + 1]) {
    const end = endOfLocalDay(year, month0, lastDayOfMonth(year, month0), ctx.tz);
    if (end && end.getTime() >= ctx.now.getTime()) return end;
  }
  return null;
}

function quarterEnd(q: number, yearText: string | undefined, ctx: Ctx): Date | null {
  const month0 = q * 3 - 1;
  return monthEnd(month0, yearText, ctx);
}

function meetingInstant(def: MeetingDef): Date {
  return dayjs.tz(`${def.date} ${def.time}:00`, 'YYYY-MM-DD HH:mm:ss', def.timeZone).toDate();
}

function findMeeting(body: MeetingBody | undefined, month0: number | null, yearText: string | undefined, ctx: Ctx): Date | null {
  if (!body) return null;
  for (const def of MEETINGS[body]) {
    const at = meetingInstant(def);
    if (at.getTime() < ctx.now.getTime()) continue;
    const [y, m] = def.date.split('-').map(Number);
    if (month0 !== null && m - 1 !== month0) continue;
    if (yearText && y !== Number(yearText)) continue;
    return at;
  }
  return null;
}

interface DeadlineRule {
  name: string;
  kind: ExtractedDeadline['kind'];
  re: RegExp;
  build(m: RegExpExecArray, ctx: Ctx): Built | null;
}

const LEAD_BY = '(?:by|through|until|no later than|on or before)\\s+(?:the\\s+end\\s+of\\s+)?';

/**
 * The grammar. One row per pattern; add rows (and corpus entries) to grow it.
 * "By X" means end of day X in the source's zone.
 */
export const DEADLINE_RULES: readonly DeadlineRule[] = [
  {
    name: 'by-date', kind: 'by',
    re: new RegExp(`\\b${LEAD_BY}(${DATE_RE})`, 'gi'),
    build: (m, ctx) => { const at = parseDate(m[1], ctx); return at ? { at } : null; },
  },
  {
    name: 'before-date', kind: 'by',
    re: new RegExp(`\\bbefore\\s+(${DATE_RE})`, 'gi'),
    build: (m, ctx) => { const at = parseDate(m[1], ctx, -1); return at ? { at } : null; },
  },
  {
    name: 'on-date', kind: 'on',
    re: new RegExp(`\\bon\\s+(${DATE_RE})`, 'gi'),
    build: (m, ctx) => { const at = parseDate(m[1], ctx); return at ? { at } : null; },
  },
  {
    name: 'end-of-month', kind: 'by',
    re: new RegExp(`\\bend\\s+of\\s+(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?(?!\\s*\\d)`, 'gi'),
    build: (m, ctx) => { const at = monthEnd(monthIndex(m[1]), m[2], ctx); return at ? { at } : null; },
  },
  {
    name: 'end-of-year', kind: 'by',
    re: /\bend\s+of\s+(\d{4})\b/gi,
    build: (m, ctx) => { const at = endOfLocalDay(Number(m[1]), 11, 31, ctx.tz); return at ? { at } : null; },
  },
  {
    name: 'quarter', kind: 'during-period',
    re: /\b(?:in|during|for|by|end\s+of)\s+(?:the\s+end\s+of\s+)?Q([1-4])(?:\s+(\d{4}))?\b/gi,
    build: (m, ctx) => {
      const at = quarterEnd(Number(m[1]), m[2], ctx);
      return at ? { at, period: { kind: 'quarter', label: `Q${m[1]}${m[2] ? ' ' + m[2] : ''}`, end: at } } : null;
    },
  },
  {
    name: 'data-month', kind: 'during-period',
    re: new RegExp(`\\b(?:for|in)\\s+(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?\\b(?!\\s*\\d)`, 'gi'),
    build: (m, ctx) => {
      const at = monthEnd(monthIndex(m[1]), m[2], ctx);
      return at ? { at, period: { kind: 'month', label: `${MONTHS[monthIndex(m[1])]}${m[2] ? ' ' + m[2] : ''}`, end: at } } : null;
    },
  },
  {
    name: 'meeting', kind: 'on',
    re: new RegExp(`\\bat\\s+(?:its|the|their)\\s+(?:(next)\\s+|(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?\\s+)(?:(?:FOMC|ECB|monetary\\s+policy|policy|rate)\\s+)*meeting\\b`, 'gi'),
    build: (m, ctx) => {
      const month0 = m[2] ? monthIndex(m[2]) : null;
      const at = findMeeting(ctx.body, month0, m[3], ctx);
      return at ? { at, period: { kind: 'meeting', label: m[1] ? 'next meeting' : `${MONTHS[month0!]} meeting`, end: at } } : null;
    },
  },
];

const COMPARATORS: Array<{ re: RegExp; op: NonNullable<ExtractedQuestion['comparator']> }> = [
  { re: /\b(?:at\s+least|no\s+less\s+than|[\d%a-z]+\s+or\s+(?:more|higher|above|greater))\b/i, op: '>=' },
  { re: /\b(?:at\s+most|no\s+more\s+than|[\d%a-z]+\s+or\s+(?:less|lower|below|fewer))\b/i, op: '<=' },
  { re: /\b(?:exceed|exceeds|above|over|more\s+than|greater\s+than|higher\s+than|surpass|rise\s+above|top)\b/i, op: '>' },
  { re: /\b(?:below|under|less\s+than|fewer\s+than|lower\s+than|fall\s+below|drop\s+below)\b/i, op: '<' },
  { re: /\b(?:exactly|equal\s+to|equals)\b/i, op: '=' },
];

const UNIT_MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, trillion: 1e12 };

function extractThreshold(masked: string): ExtractedQuestion['threshold'] {
  const re = /(\$)?\s?(\d[\d,]*(?:\.\d+)?)\s?(%|percent|bps|basis\s+points|thousand|million|billion|trillion|k|m|b)?(?![A-Za-z0-9])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const [text, dollar, num, unitRaw] = m;
    const unit = unitRaw?.toLowerCase().replace(/\s+/g, ' ');
    // A bare year is not a threshold.
    if (!dollar && !unit && /^(?:19|20)\d{2}$/.test(num)) continue;
    let value = Number(num.replace(/,/g, ''));
    if (Number.isNaN(value)) continue;
    let outUnit: string | undefined = dollar ? 'USD' : undefined;
    if (unit === '%' || unit === 'percent') outUnit = '%';
    else if (unit === 'bps' || unit === 'basis points') outUnit = 'bps';
    else if (unit && UNIT_MULT[unit]) value *= UNIT_MULT[unit];
    return { value, unit: outUnit, text: text.trim() };
  }
  return undefined;
}

/** Pulls deadline(s), comparator, threshold and subject out of a question. Pure. */
export function extractQuestion(text: string, now: Date, opts: ExtractOptions = {}): ExtractedQuestion {
  const ctx: Ctx = { now, tz: opts.timeZone ?? 'UTC', body: opts.meetingBody };
  const matches: Array<{ start: number; end: number; kind: ExtractedDeadline['kind']; built: Built; text: string }> = [];

  for (const rule of DEADLINE_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const built = rule.build(m, ctx);
      if (built) matches.push({ start: m.index, end: m.index + m[0].length, kind: rule.kind, built, text: m[0] });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  // A match wholly inside a longer one is the same phrase read twice.
  const kept = matches.filter((a) => !matches.some((b) => b !== a && b.start <= a.start && b.end >= a.end && (b.end - b.start) > (a.end - a.start)));

  const seen = new Set<number>();
  const deadlines: ExtractedDeadline[] = [];
  let periodRef: ExtractedQuestion['periodRef'];
  for (const k of kept.sort((a, b) => a.start - b.start)) {
    if (k.built.period) periodRef ??= k.built.period;
    const t = k.built.at.getTime();
    if (seen.has(t)) continue;
    seen.add(t);
    deadlines.push({ at: k.built.at, kind: k.kind, text: k.text.trim() });
  }

  // Mask the date phrases so their numbers are not read as thresholds.
  let masked = text;
  for (const k of [...kept].sort((a, b) => b.start - a.start)) masked = masked.slice(0, k.start) + ' '.repeat(k.end - k.start) + masked.slice(k.end);
  masked = masked.replace(new RegExp(DATE_RE, 'gi'), (s) => ' '.repeat(s.length));

  let comparator: ExtractedQuestion['comparator'];
  let compIndex = -1;
  for (const c of COMPARATORS) {
    const m = c.re.exec(masked);
    if (m) { comparator = c.op; compIndex = m.index; break; }
  }

  const threshold = extractThreshold(masked);
  const cleaned = text.replace(/\?+\s*$/, '').replace(/^\s*will\s+/i, '').trim();
  let subject = cleaned;
  if (compIndex >= 0) {
    const cut = masked.slice(0, compIndex).replace(/^\s*will\s+/i, '').trim();
    subject = cut || cleaned;
  }

  return { deadlines, comparator, threshold, periodRef, subject: subject || undefined };
}

// ─── Assessment ──────────────────────────────────────────────────────────────

export type ResolvabilityReason =
  | 'NO_DEADLINE' | 'AMBIGUOUS_DEADLINE' | 'DEADLINE_IN_PAST' | 'CLOSE_BEFORE_PUBLICATION'
  | 'CLOSE_TOO_LATE' | 'SOURCE_NOT_ALLOWED' | 'SOURCE_CATEGORY_MISMATCH' | 'HORIZON_TOO_LONG' | 'NOT_BINARY';

/** The `resolution` block of question document v2. */
export interface QuestionResolutionBlock {
  sourceId: SourceId;
  url: string;
  measurable: string;
  comparator: ExtractedQuestion['comparator'] | null;
  threshold: { value: number; unit: string | null; text: string } | null;
  deadlineUtc: string;
  instructions: string;
}

export interface ResolvabilityReport {
  ok: boolean;
  reasons: ResolvabilityReason[];
  repairedExpiry?: Date;
  /** Why the close time was moved: it was before publication or after the post-event window. */
  repairReasons?: Array<'CLOSE_BEFORE_PUBLICATION' | 'CLOSE_TOO_LATE'>;
  resolution?: QuestionResolutionBlock;
  /** Crypto question resolved by signers today; a Reflector price spec could replace that. */
  priceSpecCandidate?: boolean;
  sourceId?: SourceId;
  /** Allowed close-time window, when it could be computed. */
  window?: { earliestClose: Date; latestClose: Date };
}

const SOURCE_ALIASES: Record<string, SourceId> = {
  FEDERAL_RESERVE: 'FRED',
  FRED_STLOUISFED_ORG: 'FRED',
  BLS_GOV: 'BLS',
  BUREAU_OF_LABOR_STATISTICS: 'BLS',
  AP: 'AP_POLITICS',
  ASSOCIATED_PRESS: 'AP_POLITICS',
};

/** Allowed source ids named by an oracle string, in order ("BLS|FRED", "FRED, BLS"). */
export function oracleCandidates(oracle: string): SourceId[] {
  const out: SourceId[] = [];
  for (const part of String(oracle ?? '').toUpperCase().split(/[|,;/]+/)) {
    const token = part.trim().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    const id = (token in RESOLUTION_SOURCES ? token : SOURCE_ALIASES[token]) as SourceId | undefined;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

const OUTCOME_PAIR_ALLOWED = /\bon\s+or\s+(?:before|after)\b|\bor\s+(?:more|less|higher|lower|above|below|greater|fewer|equal|better|worse|later|earlier)\b/gi;

export function isBinaryQuestion(question: string): boolean {
  const q = question.replace(OUTCOME_PAIR_ALLOWED, ' ');
  if (/\bhow\s+(?:many|much)\b/i.test(q)) return false;
  if ((q.match(/\bwill\b/gi) ?? []).length > 1) return false;
  if (/\bor\b/i.test(q)) return false;
  return true;
}

const FRED_SERIES: Array<[RegExp, string]> = [
  [/\bcpi\b|consumer price/i, 'CPIAUCSL'],
  [/unemployment/i, 'UNRATE'],
  [/federal funds|fed funds|policy rate|target rate/i, 'DFEDTARU'],
  [/\bgdp\b/i, 'GDP'],
  [/payrolls?|nonfarm/i, 'PAYEMS'],
  [/10-?year|treasury yield/i, 'DGS10'],
];

function sourceUrl(def: ResolutionSourceDef, question: string): string {
  const template = def.urlTemplate ?? '';
  if (!template.includes('{series}')) return template;
  const hit = FRED_SERIES.find(([re]) => re.test(question));
  return hit ? template.replace('{series}', hit[1]) : 'https://fred.stlouisfed.org/';
}

function lagFor(def: ResolutionSourceDef, periodKind: 'month' | 'quarter' | 'meeting' | undefined): number {
  if (periodKind === 'meeting') return def.meetingLagSecs ?? def.publicationLagSecs;
  if (periodKind === 'month' || periodKind === 'quarter') return def.periodLagSecs ?? def.publicationLagSecs;
  return def.publicationLagSecs;
}

function meetingBodyFor(category: string, question: string): MeetingBody | undefined {
  if (/\becb\b|european central bank/i.test(question)) return 'ECB';
  if (/\bfomc\b|federal reserve|\bfed\b|federal funds/i.test(question)) return 'FOMC';
  if (category === 'ECB') return 'ECB';
  if (category === 'FED') return 'FOMC';
  return undefined;
}

const clampDate = (d: Date, lo: Date, hi: Date) => new Date(Math.min(Math.max(d.getTime(), lo.getTime()), hi.getTime()));

export function assessResolvability(
  p: Pick<MarketProposal, 'market_question' | 'resolution_oracle' | 'expiry_timestamp' | 'category'>,
  opts: { now: Date; disputeWindowSecs: number },
): ResolvabilityReport {
  const { now } = opts;
  const reasons: ResolvabilityReason[] = [];
  const category = String(p.category).toUpperCase();
  const question = p.market_question;

  if (!isBinaryQuestion(question)) reasons.push('NOT_BINARY');

  // Source: first allowed token that can also resolve this category.
  const candidates = oracleCandidates(p.resolution_oracle);
  let def: ResolutionSourceDef | undefined;
  if (candidates.length === 0) {
    reasons.push('SOURCE_NOT_ALLOWED');
  } else {
    const fit = candidates.find((id) => RESOLUTION_SOURCES[id].categories.includes(category as MarketCategory));
    if (fit) def = RESOLUTION_SOURCES[fit];
    else reasons.push('SOURCE_CATEGORY_MISMATCH');
  }

  const extracted = extractQuestion(question, now, {
    timeZone: def?.timeZone,
    meetingBody: meetingBodyFor(category, question),
  });

  let deadline: ExtractedDeadline | undefined;
  if (extracted.deadlines.length === 0) reasons.push('NO_DEADLINE');
  else if (extracted.deadlines.length > 1) reasons.push('AMBIGUOUS_DEADLINE');
  else deadline = extracted.deadlines[0];

  const report: ResolvabilityReport = { ok: false, reasons, sourceId: def?.id };
  if (category === 'CRYPTO' && def?.id === 'CHAINLINK') report.priceSpecCandidate = true;

  if (!def || !deadline) {
    return report;
  }

  const eventEnd = deadline.at;
  const lagSecs = lagFor(def, extracted.periodRef?.kind);
  const earliestClose = new Date(eventEnd.getTime() + lagSecs * 1000);
  const latestClose = new Date(earliestClose.getTime() + MAX_POST_EVENT_TRADING_SECS * 1000);
  report.window = { earliestClose, latestClose };

  const expiry = new Date(p.expiry_timestamp * 1000);
  const floor = new Date(Math.max(earliestClose.getTime(), now.getTime() + MIN_LEAD_SECS * 1000));
  let close = expiry;

  if (expiry.getTime() < earliestClose.getTime() || expiry.getTime() > latestClose.getTime()) {
    if (floor.getTime() > latestClose.getTime()) {
      // The answer is (or will be) public before a safe close could be scheduled.
      reasons.push('DEADLINE_IN_PAST');
    } else {
      close = clampDate(expiry, floor, latestClose);
      report.repairedExpiry = close;
      report.repairReasons = [expiry.getTime() < earliestClose.getTime() ? 'CLOSE_BEFORE_PUBLICATION' : 'CLOSE_TOO_LATE'];
    }
  }

  // close → attestation → dispute window must fit the horizon.
  const horizonEnd = close.getTime() + (opts.disputeWindowSecs + ATTESTATION_SLA_SECS) * 1000;
  if (horizonEnd > now.getTime() + MAX_HORIZON_DAYS * DAY * 1000) {
    reasons.push('HORIZON_TOO_LONG');
    delete report.repairedExpiry;
    delete report.repairReasons;
  }

  if (reasons.length === 0) {
    const thr = extracted.threshold;
    const localDeadline = dayjs(eventEnd).tz(def.timeZone).format('YYYY-MM-DD HH:mm:ss');
    report.resolution = {
      sourceId: def.id,
      url: sourceUrl(def, question),
      measurable: extracted.subject ?? question.replace(/\?+\s*$/, '').trim(),
      comparator: extracted.comparator ?? null,
      threshold: thr ? { value: thr.value, unit: thr.unit ?? null, text: thr.text } : null,
      deadlineUtc: eventEnd.toISOString(),
      instructions: `${def.instructions} Deadline: ${localDeadline} (${def.timeZone}) = ${eventEnd.toISOString()}. Resolve on the first published value.`,
    };
  }

  report.ok = reasons.length === 0;
  return report;
}
