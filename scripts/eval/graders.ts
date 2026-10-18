/**
 * Graders for generated market proposals (#67). Each returns
 * { pass, score: 0..1, detail }. Rules are hard: the LLM judge can add a
 * failure but never turns a rule failure into a pass, and rule/judge
 * disagreements are reported separately.
 */
import { ALLOWED_ORACLES } from '../../src/services/market-policy';
import { isDuplicateOf } from '../../src/services/market.service';
import type { MarketProposal } from '../../src/types';
import { dayDiff, extractQuestionDates } from './dates';
import type { JudgeVerdict } from './judge-prompt.v1';

export const GRADER_NAMES = [
  'schemaValid',
  'binary',
  'resolutionSource',
  'dateSanity',
  'category',
  'duplicateAccuracy',
  'ciConsistency',
] as const;
export type GraderName = (typeof GRADER_NAMES)[number];

export interface GradeResult {
  pass: boolean;
  score: number;
  /** false when the case carries no label for this grader; it is then left out of rates. */
  applicable: boolean;
  detail: Record<string, unknown>;
}

export interface EvalCase {
  id: string;
  asOf: string;
  signals: { news: any[]; fed: any[]; macro: any[]; signalCount: number };
  existing: Array<{ question: string; category: string }>;
  labels: { category?: string | null; expectDuplicateOf?: string | null; notes?: string };
}

const result = (pass: boolean, detail: Record<string, unknown> = {}, applicable = true): GradeResult => ({
  pass, score: pass ? 1 : 0, applicable, detail,
});

// ─── binary-ness ─────────────────────────────────────────────────────────────
// "at or above", "on or before", "3% or more" are thresholds, not alternatives.
const BENIGN_OR = /\b(?:at or (?:above|below)|on or (?:before|after)|(?:[\w.,%$]+\s+)?or (?:more|less|fewer|higher|lower|greater|equal|earlier|later))\b/gi;
const COMPARATORS = /\b(?:above|below|exceed|exceeds|over|under|at least|at most|more than|less than|higher than|lower than|reach|reaches|hit|hits|rise|fall)\b/i;

export function binaryRule(question: string): { pass: boolean; reasons: string[] } {
  const q = question.trim();
  const reasons: string[] = [];
  const stripped = q.replace(BENIGN_OR, ' ');
  if ((q.match(/\?/g) ?? []).length !== 1 || !q.endsWith('?')) reasons.push('not exactly one question ending in "?"');
  if (!/^(?:will|is|are|does|do|did|has|have|can|could|would|should)\b/i.test(q)) reasons.push('not phrased as a yes/no question');
  if (/\bor\b/i.test(stripped)) reasons.push('offers alternatives ("or")');
  if (/\bhow (?:many|much)\b/i.test(q)) reasons.push('asks for a quantity ("how many/much")');
  if (/\bwhich\b/i.test(q)) reasons.push('asks to choose ("which")');
  // A bucket such as "4.0 to 4.5" or "between X and Y" is not a threshold. Day ranges
  // ("October 23-25") and a policy "target range" are not buckets.
  const noDays = q.replace(/\b[A-Z][a-z]+\.?\s+\d{1,2}\s*[-–]\s*\d{1,2}\b/g, ' ');
  const bucket = /\bbetween\b[^?]*\band\b/i.test(noDays) || /\d[\d.,]*\s*(?:%|percent)?\s*(?:to|[-–—])\s*\d[\d.,]*/i.test(noDays);
  if (bucket && !COMPARATORS.test(q)) reasons.push('range without a threshold');
  return { pass: reasons.length === 0, reasons };
}

export function gradeBinary(question: string, judge: JudgeVerdict | null): GradeResult {
  const rule = binaryRule(question);
  const judged = judge ? judge.binary === 1 : null;
  const pass = rule.pass && judged !== false;
  return {
    pass,
    score: !rule.pass ? 0 : judged === null ? 1 : judge!.binary,
    applicable: true,
    detail: { rule, judge: judge ? { binary: judge.binary, notes: judge.ambiguity_notes } : null, disagreement: judged !== null && judged !== rule.pass },
  };
}

// ─── verifiable resolution source ────────────────────────────────────────────
const ORACLES = new Set<string>(ALLOWED_ORACLES);

export function gradeResolutionSource(oracle: string, judge: JudgeVerdict | null): GradeResult {
  const rule = ORACLES.has(oracle);
  const judged = judge ? judge.verifiable === 1 : null;
  return {
    pass: rule && judged !== false,
    score: !rule ? 0 : judged === null ? 1 : judge!.verifiable,
    applicable: true,
    detail: { oracle, inAllowList: rule, judge: judge ? { verifiable: judge.verifiable } : null, disagreement: judged !== null && judged !== rule },
  };
}

// ─── date sanity ─────────────────────────────────────────────────────────────
export function gradeDateSanity(question: string, expiryTimestamp: number, asOf: Date): GradeResult {
  const expiry = new Date(expiryTimestamp * 1000);
  const days = (expiry.getTime() - asOf.getTime()) / 86_400_000;
  const inWindow = days >= 1 && days <= 90;
  const dates = extractQuestionDates(question, asOf);
  // The latest date written in the question is the resolution deadline.
  const stated = dates.length > 0 ? dates[dates.length - 1] : null;
  const delta = stated ? dayDiff(stated, expiry) : null;
  const consistent = delta === null || Math.abs(delta) <= 2;
  return result(inWindow && consistent, {
    expiry: expiry.toISOString(),
    daysFromAsOf: Number(days.toFixed(2)),
    inWindow,
    questionDates: dates.map((d) => d.toISOString().slice(0, 10)),
    deltaDays: delta,
  });
}

// ─── category / duplicates / interval ────────────────────────────────────────
export function gradeCategory(category: string, label: string | null | undefined): GradeResult {
  if (!label) return result(true, { skipped: 'unlabelled' }, false);
  return result(category === label, { expected: label, got: category });
}

export function gradeDuplicate(
  question: string,
  existing: Array<{ question: string }>,
  expectDuplicateOf: string | null | undefined,
): GradeResult {
  const expected = expectDuplicateOf != null;
  const got = isDuplicateOf(question, existing.map((e) => e.question));
  return result(got === expected, { expectedDuplicate: expected, flaggedDuplicate: got });
}

export function gradeCiConsistency(p: number, ci: { lower: number; upper: number }): GradeResult {
  const ordered = ci.lower < p && p < ci.upper;
  const width = ci.upper - ci.lower;
  return result(ordered && width <= 0.4, { p, lower: ci.lower, upper: ci.upper, width: Number(width.toFixed(4)), ordered });
}

// ─── whole case ──────────────────────────────────────────────────────────────
/** A parse failure fails every applicable grader, so a bad prompt cannot hide behind a small denominator. */
export function gradeCase(
  c: EvalCase,
  parsed: { proposal: MarketProposal } | { error: string },
  judge: JudgeVerdict | null,
): Record<GraderName, GradeResult> {
  if ('error' in parsed) {
    const fail = (applicable = true): GradeResult => ({ pass: false, score: 0, applicable, detail: { reason: 'no valid proposal', error: parsed.error } });
    return {
      schemaValid: fail(),
      binary: fail(),
      resolutionSource: fail(),
      dateSanity: fail(),
      category: fail(!!c.labels.category),
      duplicateAccuracy: fail(),
      ciConsistency: fail(),
    };
  }
  const p = parsed.proposal;
  return {
    schemaValid: result(true),
    binary: gradeBinary(p.market_question, judge),
    resolutionSource: gradeResolutionSource(p.resolution_oracle, judge),
    dateSanity: gradeDateSanity(p.market_question, p.expiry_timestamp, new Date(c.asOf)),
    category: gradeCategory(String(p.category), c.labels.category),
    duplicateAccuracy: gradeDuplicate(p.market_question, c.existing, c.labels.expectDuplicateOf),
    ciConsistency: gradeCiConsistency(p.initial_yes_probability, p.confidence_interval),
  };
}
