/** @format */

import { prisma } from "../lib/prisma";
import { writeAgentLog } from "../lib/agent-log";
import { callLLMStructured } from '../lib/llm';
import { marketProposalV1 } from '../lib/prompts';
import type { LlmProvenance } from '../lib/llm/provenance';
import { LlmBudgetExceeded, type CallContext } from '../lib/llm-budget';
import {
  confidenceIntervalError,
  marketProposalSchema,
  marketProposalSpec,
} from '../lib/llm-schema';
import { logger } from "../lib/logger";
import type {
  AggregatedSignal,
  MarketProposal,
  AggregatedSignals,
  WeightedSignal,
  ConfidenceInterval,
} from "../types";
import { Prisma, MarketCategory } from '@prisma/client';
import type { Market } from "@prisma/client";
import { AppError } from "../middlewares/error.middleware";
import dayjs from "dayjs";
import { canonicalJson, sha256Hex } from '../utils/hash.util';
import {
  checkProposal,
  partitionSignals,
  renderUntrustedBlock,
  sanitizeSignal,
  sanitizeSignalText,
  type SanitizedSignal,
} from './llm-guard.service';
import { ALLOWED_ORACLES, SOURCE_WEIGHTS, meaningfulTokens, tokenOverlap } from './market-policy';
import {
  assessResolvability,
  type QuestionResolutionBlock,
} from './resolvability.service';
import { config } from '../config';
import { now as clockNow } from '../lib/clock';
import { extractQuestionDates, dayDiff } from '../lib/question-dates';
import { extractEntities, sharedEntities, uniqueEntities } from './dedup-entities';
import { getEmbeddingProvider, getVectorIndex, normalizeQuestion, type Neighbour } from './embeddings.service';

// The proposal schemas live in src/lib/llm-schema.ts (single source for the
// zod shape, the Anthropic tool schema and the Gemini response schema).
export { marketProposalSchema };
export { ALLOWED_ORACLES, SOURCE_WEIGHTS, meaningfulTokens };

const NEWS_LIMIT = 6;
const FED_LIMIT = 4;
const MACRO_LIMIT = 4;

/** Signals as the model will see them, with citable ids. */
interface PromptSignals {
  sent: SanitizedSignal[];
  quarantined: SanitizedSignal[];
  /** Citable id (n1, f1, m1…) → the aggregated signal it was built from, store id included (#73). */
  sources: Record<string, AggregatedSignal>;
}

/**
 * Sanitises (idempotently), drops instruction-like signals and caps each group,
 * assigning the ids the model must cite: n1.. (news), f1.. (fed), m1.. (macro).
 */
function selectPromptSignals(signals: AggregatedSignals): PromptSignals {
  const quarantined: SanitizedSignal[] = [];
  const sources: Record<string, AggregatedSignal> = {};
  const pick = (group: AggregatedSignal[], prefix: string, limit: number): SanitizedSignal[] => {
    const sanitized = group.map((s) => sanitizeSignal(s));
    const parts = partitionSignals(sanitized);
    quarantined.push(...parts.quarantined);
    return parts.clean.slice(0, limit).map((s, i) => {
      const id = `${prefix}${i + 1}`;
      sources[id] = group[sanitized.indexOf(s)];
      return { ...s, id };
    });
  };
  const sent = [
    ...pick(signals.news, 'n', NEWS_LIMIT),
    ...pick(signals.fed, 'f', FED_LIMIT),
    ...pick(signals.macro, 'm', MACRO_LIMIT),
  ];
  return { sent, quarantined, sources };
}

const hashSignal = (s: SanitizedSignal) => sha256Hex(canonicalJson(s));

function countBySource(signals: SanitizedSignal[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of signals) out[s.source] = (out[s.source] ?? 0) + 1;
  return out;
}

/** The slice of an existing market the prompt needs. */
export interface ExistingMarketRef {
  question: string;
  category: string;
}

export interface MarketPrompts {
  system: string;
  user: string;
  /** Signals shown to the model, with their citable ids. */
  sent: SanitizedSignal[];
  quarantined: SanitizedSignal[];
  /** Citable id → aggregated signal (with its store id), for trace provenance. */
  sources: Record<string, AggregatedSignal>;
}

/**
 * Pure prompt construction (#67): no Prisma, no clock. Untrusted text
 * (headlines, descriptions, earlier market questions) is sanitised and sent
 * only inside nonce-delimited data blocks. `opts.nonceSeed` makes the nonces
 * deterministic so the offline evaluation can key recordings by prompt hash;
 * production leaves it unset and gets a fresh random nonce per block.
 */
export function buildMarketPrompts(
  signals: AggregatedSignals,
  existingMarkets: ExistingMarketRef[],
  now: Date,
  opts: { nonceSeed?: string } = {},
): MarketPrompts {
  const { sent, quarantined, sources } = selectPromptSignals(signals);
  const nonce = (label: string) =>
    opts.nonceSeed === undefined ? undefined : sha256Hex(`${opts.nonceSeed}:${label}`).slice(0, 12);

  // Earlier market questions are model output that may carry a past injection:
  // sanitised, dropped if instruction-like, and delimited like any other data.
  const existing: SanitizedSignal[] = existingMarkets
    .map((m) => sanitizeSignal({
      source: String(m.category), title: m.question, content: '', publishedAt: '', relevanceScore: 0, category: String(m.category),
    }))
    .filter((s) => !s.sanitizedFlags.includes('instruction_like'))
    .map((s, i) => ({ ...s, id: `e${i + 1}` }));
  const existingBlock = existing.length > 0
    ? `ALREADY EXISTING MARKETS (DO NOT create similar markets on these topics):\n${renderUntrustedBlock(existing, 'existing_markets', nonce('existing_markets'))}\n`
    : '';

  const { system, user } = marketProposalV1.render({
    now: dayjs(now).toISOString(),
    existingBlock,
    signalCount: signals.signalCount,
    shownCount: sent.length,
    signalsBlock: renderUntrustedBlock(sent, 'untrusted_signals', nonce('untrusted_signals')),
  });
  return { system, user, sent, quarantined, sources };
}

export interface GeneratedProposal {
  proposal: MarketProposal;
  /** Who produced the proposal (#66); stored in Market.generationProvenance. */
  provenance: LlmProvenance;
  /** The signals the proposal cites in grounding_signal_ids, as aggregated (#73). */
  groundingSignals: AggregatedSignal[];
}

/**
 * Generates a validated binary prediction market proposal from signal data.
 *
 * The answer comes back through a schema-constrained call (callLLMStructured)
 * and must then pass the deterministic policy in llm-guard.service.ts before
 * it can become a market. Rejections are logged with reason codes and signal
 * hashes, never raw text. Returns the proposal together with the provenance of
 * the call that produced it.
 */
export async function generateMarketQuestion(
  signals: AggregatedSignals,
  ctx: CallContext = { purpose: 'market_generation', priority: 'cron' },
): Promise<GeneratedProposal> {
  const existingMarkets = await prisma.market.findMany({
    where:  { status: { in: ['PENDING', 'ACTIVE'] } },
    select: { question: true, category: true },
    orderBy: { createdAt: 'desc' },
    take:   50,
  });
  const { system, user, sent, quarantined, sources } = buildMarketPrompts(signals, existingMarkets, clockNow());

  if (quarantined.length > 0) {
    await logAgentAction('MARKET_MAKER', 'WARN', 'SIGNALS_QUARANTINED', null, {
      quarantinedCount: quarantined.length,
      bySource: countBySource(quarantined),
      signalHashes: quarantined.map(hashSignal),
    });
  }
  if (sent.length === 0) {
    // Nothing trustworthy to ground a market in: skip rather than call the model.
    throw new AppError(422, 'NO_USABLE_SIGNALS', 'No usable signals after sanitisation and quarantine', {
      quarantinedCount: quarantined.length,
    });
  }

  let value: unknown;
  let provenance: LlmProvenance;
  let llm: { provider: string; model: string; attempts: number };
  try {
    const result = await callLLMStructured(
      marketProposalSpec,
      { system, user },
      {
        maxTokens: 4096,
        ctx,
        task: 'market_generation',
        prompt: { id: marketProposalV1.id, version: marketProposalV1.version, hash: marketProposalV1.contentHash },
      },
    );
    value = result.value;
    provenance = result.provenance;
    llm = { provider: result.provider, model: result.model, attempts: result.attempts };
  } catch (err) {
    // The budget is a normal, expected stop: the cycle logs it once per day.
    if (err instanceof LlmBudgetExceeded) throw err;
    await logAgentAction('MARKET_MAKER', 'ERROR', 'GENERATE_QUESTION_LLM_FAIL', null, {
      code:        err instanceof AppError ? err.code : 'UNKNOWN',
      details:     err instanceof AppError ? err.details : undefined,
      signalCount: signals.signalCount,
    });
    if (err instanceof AppError) throw err;
    throw new AppError(500, 'LLM_CALL_FAILED', 'LLM API call failed during market generation');
  }

  await logAgentAction('MARKET_MAKER', 'INFO', 'GENERATE_QUESTION_LLM', null, {
    signalCount: signals.signalCount,
    llm,
  });

  const proposal = parseProposal(value);

  const verdict = checkProposal(proposal, sent, clockNow());
  if (!verdict.ok) {
    const cited = new Set(proposal.grounding_signal_ids);
    await logAgentAction('MARKET_MAKER', 'WARN', 'PROPOSAL_REJECTED', null, {
      reasons: verdict.reasons,
      detail: verdict.detail,
      // Hashes of the cited signals, never their text.
      signalHashes: sent.filter((s) => s.id && cited.has(s.id)).map(hashSignal),
      quarantinedCount: quarantined.length,
    });
    throw new AppError(422, 'PROPOSAL_REJECTED_BY_GUARD', 'Proposal rejected by the injection guard', {
      reasons: verdict.reasons,
    });
  }
  const groundingSignals = proposal.grounding_signal_ids
    .map((id) => sources[id])
    .filter((s): s is AggregatedSignal => Boolean(s));
  return { proposal, provenance, groundingSignals };
}

/**
 * Domain parse of a proposal object (defaults applied) plus the confidence
 * interval rule. Error codes are kept from the pre-structured pipeline.
 */
export function parseProposal(parsed: unknown): MarketProposal {
  const result = marketProposalSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(422, 'SCHEMA_VALIDATION_FAILED', 'LLM output failed schema validation', {
      errors: result.error.flatten().fieldErrors,
    });
  }

  if (confidenceIntervalError(result.data)) {
    const { initial_yes_probability: p, confidence_interval: ci } = result.data;
    throw new AppError(422, 'INVALID_CONFIDENCE_INTERVAL',
      'Probability must be within the confidence interval bounds', { p, ci });
  }

  return result.data as MarketProposal;
}

/**
 * Thin wrapper kept for tests and backward compatibility: parses a raw JSON
 * string. There is no fence stripping; a fenced reply is invalid JSON.
 */
export function validateMarketQuestion(rawLlmOutput: string): MarketProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLlmOutput);
  } catch {
    throw new AppError(422, 'INVALID_LLM_JSON', 'LLM returned non-parseable JSON');
  }
  return parseProposal(parsed);
}

/**
 * Computes a weighted probability estimate from a list of signals.
 *
 * WARNING: the estimate is a weighted mean of `rawValue`. Never call it with
 * `rawValue` set to the price the result is compared against: the "estimate"
 * then equals the price and the edge is zero by construction (the trader bug
 * fixed in #75). The trader uses forecast.service.ts; this function remains
 * for the market-maker path.
 */
export function calculateProbability(
  signals: WeightedSignal[],
  baseMarketPrice: number,
): { probability: number; confidenceInterval: ConfidenceInterval } {
  if (signals.length === 0) {
    return {
      probability:        baseMarketPrice,
      confidenceInterval: { lower: baseMarketPrice - 0.10, upper: baseMarketPrice + 0.10 },
    };
  }

  const weightedSum = signals.reduce((acc, s) => {
    const w = SOURCE_WEIGHTS[s.source.toUpperCase()] ?? 0.5;
    return acc + (s.rawValue ?? baseMarketPrice) * w;
  }, 0);

  const totalWeight = signals.reduce((acc, s) => {
    return acc + (SOURCE_WEIGHTS[s.source.toUpperCase()] ?? 0.5);
  }, 0);

  const probability = Math.min(0.99, Math.max(0.01, weightedSum / totalWeight));

  const values   = signals.map(s => s.rawValue ?? baseMarketPrice);
  const mean     = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev   = Math.sqrt(variance);

  const ci: ConfidenceInterval = {
    lower: Math.max(0.01, probability - 1.96 * stdDev),
    upper: Math.min(0.99, probability + 1.96 * stdDev),
  };

  return { probability, confidenceInterval: ci };
}

/**
 * Derives a sensible expiry date from the market category.
 */
export function generateExpiryDate(category: string): Date {
  const base = dayjs();
  switch (category) {
    case 'FED':           return base.add(30, 'day').toDate();
    case 'ECB':           return base.add(30, 'day').toDate();
    case 'ELECTION':      return base.add(90, 'day').toDate();
    case 'GEOPOLITICAL':  return base.add(14, 'day').toDate();
    case 'CRYPTO':        return base.add(7,  'day').toDate();
    case 'MACRO':         return base.add(21, 'day').toDate();
    case 'SPORTS':        return base.add(14, 'day').toDate();
    case 'ENTERTAINMENT': return base.add(30, 'day').toDate();
    case 'POLITICS':      return base.add(30, 'day').toDate();
    default:              return base.add(21, 'day').toDate();
  }
}

/**
 * Persists a validated MarketProposal to the database.
 */
/** The proposal's category as a MarketCategory (MACRO when the model invents one). */
export function normalizeCategory(raw: unknown): MarketCategory {
  const upper = String(raw).toUpperCase();
  return Object.values(MarketCategory).includes(upper as MarketCategory) ? (upper as MarketCategory) : MarketCategory.MACRO;
}

export async function createMarketFromProposal(
  proposal: MarketProposal,
  provenance?: LlmProvenance,
  resolutionDetails?: QuestionResolutionBlock | null,
): Promise<Market> {
  const finalCategory = normalizeCategory(proposal.category);

  const market = await prisma.market.create({
    data: {
      question:           proposal.market_question,
      category:           finalCategory,
      status:             "PENDING",
      settlementCurrency: "USDC",
      initialYesProb:     proposal.initial_yes_probability,
      currentYesProb:     proposal.initial_yes_probability,
      confidenceInterval: proposal.confidence_interval as any,
      expiryTimestamp:    new Date(proposal.expiry_timestamp * 1000),
      resolutionOracle:   proposal.resolution_oracle,
      minimumLiquidity:   proposal.minimum_liquidity_usdc,
      ...(resolutionDetails ? { resolutionDetails: resolutionDetails as unknown as Prisma.InputJsonValue } : {}),
      ...(provenance ? { generationProvenance: provenance as unknown as Prisma.InputJsonValue } : {}),
    },
  });

  await logAgentAction("MARKET_MAKER", "INFO", "MARKET_CREATED", market.id, {
    question:    market.question,
    probability: market.initialYesProb,
    oracle:      market.resolutionOracle,
    category:    market.category,
  });

  logger.info(
    { marketId: market.id, question: market.question, category: market.category },
    "Market created",
  );
  return market;
}

/**
 * Runs the deterministic resolvability check (#74) before anything is
 * persisted or pinned. Returns null (after logging PROPOSAL_UNRESOLVABLE) when
 * the proposal can't be resolved by its committed source; otherwise returns
 * the proposal, with its expiry repaired into the allowed window if needed
 * (logged as PROPOSAL_EXPIRY_REPAIRED), and the resolution block to store.
 */
export async function prepareResolvableProposal(
  proposal: MarketProposal,
  now = clockNow(),
): Promise<{ proposal: MarketProposal; resolution: QuestionResolutionBlock } | null> {
  const report = assessResolvability(proposal, {
    now,
    disputeWindowSecs: config.RESOLUTION_DISPUTE_WINDOW_SECS,
  });
  if (!report.ok || !report.resolution) {
    await logAgentAction('MARKET_MAKER', 'WARN', 'PROPOSAL_UNRESOLVABLE', null, {
      reasons: report.reasons,
      category: proposal.category,
      oracle: proposal.resolution_oracle,
      expiry: new Date(proposal.expiry_timestamp * 1000).toISOString(),
      window: report.window
        ? { earliestClose: report.window.earliestClose.toISOString(), latestClose: report.window.latestClose.toISOString() }
        : null,
    });
    return null;
  }
  let result = proposal;
  if (report.repairedExpiry) {
    const after = Math.floor(report.repairedExpiry.getTime() / 1000);
    await logAgentAction('MARKET_MAKER', 'INFO', 'PROPOSAL_EXPIRY_REPAIRED', null, {
      before: new Date(proposal.expiry_timestamp * 1000).toISOString(),
      after: report.repairedExpiry.toISOString(),
      reasons: report.repairReasons,
      sourceId: report.sourceId,
    });
    result = { ...proposal, expiry_timestamp: after };
  }
  return { proposal: result, resolution: report.resolution };
}

/**
 * Check if a similar market already exists to avoid duplicates.
 *
 * Two-pass check:
 *  1. Word-overlap Jaccard similarity (threshold 0.55 — tighter than before)
 *  2. Key-entity phrase overlap: if 3+ meaningful n-grams match, treat as duplicate
 *     even when overall word overlap is lower (catches paraphrase variants like
 *     "hold…unchanged" vs "keep…unchanged" vs "remain at").
 */
export async function isDuplicateMarket(question: string): Promise<boolean> {
  const activeMarkets = await prisma.market.findMany({
    where:  { status: { in: ['PENDING', 'ACTIVE'] } },
    select: { question: true },
  });
  return isDuplicateOf(question, activeMarkets.map((m) => m.question));
}

function bigrams(tokens: string[]): Set<string> {
  const bg = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    bg.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bg;
}

/**
 * The first existing question the lexical rule (Jaccard > 0.55, or 3+ shared
 * bigrams) calls a duplicate, with its Jaccard score. Pure (#67).
 */
export function findLexicalMatch(question: string, existing: string[]): { index: number; jaccard: number } | null {
  const newTokens    = meaningfulTokens(question);
  const newTokensSet = new Set(newTokens);
  const newBigrams   = bigrams(newTokens);

  for (let index = 0; index < existing.length; index++) {
    const existingTokens = meaningfulTokens(existing[index]);

    // Pass 1: Jaccard similarity on meaningful tokens (threshold 0.55)
    const intersection = tokenOverlap(existingTokens, newTokensSet);
    const union        = new Set([...newTokens, ...existingTokens]).size;
    const jaccard      = union === 0 ? 0 : intersection / union;
    if (jaccard > 0.55) return { index, jaccard };

    // Pass 2: Key-entity n-gram overlap; 3+ shared meaningful bigrams → duplicate
    const existingBigrams = bigrams(existingTokens);
    const bigramOverlap   = [...newBigrams].filter(bg => existingBigrams.has(bg)).length;
    if (bigramOverlap >= 3) return { index, jaccard };
  }

  return null;
}

/** The pure lexical rule behind {@link isDuplicateMarket}: the question list is a parameter. */
export function isDuplicateOf(question: string, existing: string[]): boolean {
  return findLexicalMatch(question, existing) !== null;
}

// ─── Semantic dedup (#69) ─────────────────────────────────────────────────────

export interface DedupMatch {
  marketId: string;
  question: string;
  /** Cosine similarity (semantic) or Jaccard score (lexical). */
  similarity: number;
  reason: string;
}

export interface DedupResult {
  duplicate: boolean;
  method: 'semantic' | 'lexical';
  match?: DedupMatch;
}

/** At or above this similarity two questions are the same market whatever else differs. */
export const DEDUP_CERTAIN_SIM = 0.95;
const NEIGHBOURS = 10;
const DAY_MS = 86_400_000;

type DedupProposal = Pick<MarketProposal, 'market_question' | 'category' | 'expiry_timestamp'>;

/**
 * Nearest PENDING/ACTIVE markets by cosine similarity (HNSW), best first.
 * Throws if embedding or the query fails; checkDuplicate turns that into the
 * lexical fallback. `category` and `expiry` are not used to filter: the same
 * event can be filed under two categories, and dates are judged in stage two.
 */
export async function findSemanticDuplicates(
  question: string,
  _context: { category: string; expiry: Date },
): Promise<Neighbour[]> {
  const provider = getEmbeddingProvider();
  if (!provider) return [];
  const [vector] = await provider.embed([normalizeQuestion(question)]);
  return getVectorIndex().nearest(vector, provider.model, NEIGHBOURS);
}

/** Numbers in a normalised question (dates are already gone), as canonical strings. */
function figures(question: string): Set<string> {
  const out = new Set<string>();
  // Not "q3" or "p500": digits glued to a letter are part of a name.
  for (const m of normalizeQuestion(question).matchAll(/(?<![a-z\d.])\d+(?:\.\d+)?/g)) out.add(String(parseFloat(m[0])));
  return out;
}

/**
 * Stage two, for a neighbour that cleared the similarity threshold. "Same
 * subject, different date" is a different market, and so are two rungs of a
 * ladder ("above $70,000" / "above $90,000"), so a candidate is a duplicate
 * only when, in order:
 *   1. the resolution dates (expiry, and any date written in both questions)
 *      are within the window;
 *   2. neither question states a figure the other lacks while the other also
 *      states one the first lacks (conflicting numbers);
 *   3. the questions share an entity and neither adds an entity the other
 *      lacks while the other adds one too (Lakers vs Celtics).
 * Similarity ≥ 0.95 skips step 3 only: near-identical text with an entity our
 * gazetteer cannot map is still a repeat, but never across dates or figures.
 * Pure.
 */
export function confirmDuplicate(
  proposal: { question: string; expiry: Date },
  candidate: { question: string; expiry: Date; similarity: number },
  windowDays = config.DEDUP_DATE_WINDOW_DAYS,
): { duplicate: boolean; reason: string } {
  const expiryGap = Math.abs(proposal.expiry.getTime() - candidate.expiry.getTime()) / DAY_MS;
  if (expiryGap > windowDays) {
    return { duplicate: false, reason: `resolution dates differ by ${expiryGap.toFixed(1)} days (window ${windowDays})` };
  }

  // Dates written in the text refine the expiry comparison when both have one.
  const written = (q: string, expiry: Date) => {
    const dates = extractQuestionDates(q, new Date(expiry.getTime() - 60 * DAY_MS));
    return dates.length > 0 ? dates[dates.length - 1] : null;
  };
  const a = written(proposal.question, proposal.expiry);
  const b = written(candidate.question, candidate.expiry);
  if (a && b && Math.abs(dayDiff(a, b)) > windowDays) {
    return { duplicate: false, reason: `dates in the questions differ by ${Math.abs(dayDiff(a, b))} days (window ${windowDays})` };
  }

  const figuresA = figures(proposal.question);
  const figuresB = figures(candidate.question);
  const onlyA = [...figuresA].filter((x) => !figuresB.has(x));
  const onlyB = [...figuresB].filter((x) => !figuresA.has(x));
  if (onlyA.length > 0 && onlyB.length > 0) {
    return { duplicate: false, reason: `different figures (${onlyA.join(', ')} vs ${onlyB.join(', ')})` };
  }

  if (candidate.similarity >= DEDUP_CERTAIN_SIM) {
    return { duplicate: true, reason: `similarity ${candidate.similarity.toFixed(3)} ≥ ${DEDUP_CERTAIN_SIM}; same date window` };
  }

  const entitiesA = extractEntities(proposal.question);
  const entitiesB = extractEntities(candidate.question);
  const shared = sharedEntities(entitiesA, entitiesB);
  if (shared.length === 0) return { duplicate: false, reason: 'no shared entity' };
  const [extraA, extraB] = uniqueEntities(entitiesA, entitiesB);
  if (extraA.length > 0 && extraB.length > 0) {
    return { duplicate: false, reason: `different subjects (${extraA.join(', ')} vs ${extraB.join(', ')})` };
  }

  return { duplicate: true, reason: `shared entities ${shared.join(', ')}; resolution within ${windowDays} days` };
}

async function lexicalCheck(question: string): Promise<DedupResult> {
  const active = await prisma.market.findMany({
    where:  { status: { in: ['PENDING', 'ACTIVE'] } },
    select: { id: true, question: true },
  });
  const hit = findLexicalMatch(question, active.map((m) => m.question));
  if (!hit) return { duplicate: false, method: 'lexical' };
  const m = active[hit.index];
  return { duplicate: true, method: 'lexical', match: { marketId: m.id, question: m.question, similarity: hit.jaccard, reason: 'lexical overlap (Jaccard > 0.55 or 3+ shared bigrams)' } };
}

/**
 * Duplicate check for a proposal (#69). With an embedding provider: nearest
 * neighbours by cosine similarity, candidates at or above DEDUP_SIM_THRESHOLD,
 * then the entity and date stage. Markets the vector index cannot see (no
 * embedding yet, or another model's) are compared lexically so nothing is
 * skipped. Without a provider, or if embedding or the query fails, the lexical
 * check runs instead and the result says so; this never throws for a provider
 * problem and never blocks the cycle.
 */
export async function checkDuplicate(proposal: DedupProposal): Promise<DedupResult> {
  const provider = getEmbeddingProvider();
  if (!provider) return lexicalCheck(proposal.market_question);

  const expiry = new Date(proposal.expiry_timestamp * 1000);
  try {
    const neighbours = await findSemanticDuplicates(proposal.market_question, { category: String(proposal.category), expiry });
    for (const n of neighbours.filter((x) => x.similarity >= config.DEDUP_SIM_THRESHOLD)) {
      const verdict = confirmDuplicate(
        { question: proposal.market_question, expiry },
        { question: n.question, expiry: n.expiryTimestamp, similarity: n.similarity },
      );
      if (verdict.duplicate) {
        return { duplicate: true, method: 'semantic', match: { marketId: n.marketId, question: n.question, similarity: n.similarity, reason: verdict.reason } };
      }
    }

    const unseen = await getVectorIndex().unembedded(provider.model);
    const hit = findLexicalMatch(proposal.market_question, unseen.map((m) => m.question));
    if (hit) {
      const m = unseen[hit.index];
      return { duplicate: true, method: 'lexical', match: { marketId: m.id, question: m.question, similarity: hit.jaccard, reason: 'lexical overlap with a market that has no embedding yet' } };
    }
    return { duplicate: false, method: 'semantic' };
  } catch (err) {
    logger.warn({ err: (err as Error)?.message?.slice(0, 200) }, 'Semantic dedup unavailable; falling back to the lexical check');
    return lexicalCheck(proposal.market_question);
  }
}

// ─── Internal helper ──────────────────────────────────────────────────────────
async function logAgentAction(
  agentType: "MARKET_MAKER" | "TRADER",
  level:     "INFO" | "WARN" | "ERROR" | "DEBUG",
  action:    string,
  marketId:  string | null,
  data?:     Record<string, unknown>,
): Promise<void> {
  try {
    await writeAgentLog({ agentType, level, action, marketId: marketId ?? undefined, data });
  } catch (err) {
    logger.error({ err }, "Failed to write agent log");
  }
}