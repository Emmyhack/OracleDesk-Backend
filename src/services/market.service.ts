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
import { ALLOWED_ORACLES, SOURCE_WEIGHTS, meaningfulTokens } from './market-policy';

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
}

/**
 * Sanitises (idempotently), drops instruction-like signals and caps each group,
 * assigning the ids the model must cite: n1.. (news), f1.. (fed), m1.. (macro).
 */
function selectPromptSignals(signals: AggregatedSignals): PromptSignals {
  const quarantined: SanitizedSignal[] = [];
  const pick = (group: SanitizedSignal[], prefix: string, limit: number): SanitizedSignal[] => {
    const parts = partitionSignals(group.map((s) => sanitizeSignal(s)));
    quarantined.push(...parts.quarantined);
    return parts.clean.slice(0, limit).map((s, i) => ({ ...s, id: `${prefix}${i + 1}` }));
  };
  const sent = [
    ...pick(signals.news, 'n', NEWS_LIMIT),
    ...pick(signals.fed, 'f', FED_LIMIT),
    ...pick(signals.macro, 'm', MACRO_LIMIT),
  ];
  return { sent, quarantined };
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
  const { sent, quarantined } = selectPromptSignals(signals);
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
  return { system, user, sent, quarantined };
}

export interface GeneratedProposal {
  proposal: MarketProposal;
  /** Who produced the proposal (#66); stored in Market.generationProvenance. */
  provenance: LlmProvenance;
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
  const { system, user, sent, quarantined } = buildMarketPrompts(signals, existingMarkets, new Date());

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

  const verdict = checkProposal(proposal, sent, new Date());
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
  return { proposal, provenance };
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
export async function createMarketFromProposal(
  proposal: MarketProposal,
  provenance?: LlmProvenance,
): Promise<Market> {
  const upperCategory = String(proposal.category).toUpperCase();
  const finalCategory = Object.values(MarketCategory).includes(upperCategory as MarketCategory)
    ? (upperCategory as MarketCategory)
    : MarketCategory.MACRO;

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
 * The pure lexical rule behind {@link isDuplicateMarket} (#67): the question
 * list is a parameter, so the offline evaluation runs it without Prisma.
 */
export function isDuplicateOf(question: string, existing: string[]): boolean {
  const newTokens    = meaningfulTokens(question);
  const newTokensSet = new Set(newTokens);
  const newBigrams   = bigrams(newTokens);

  for (const text of existing) {
    const existingTokens = meaningfulTokens(text);

    // Pass 1: Jaccard similarity on meaningful tokens (threshold 0.55)
    const intersection = existingTokens.filter(w => newTokensSet.has(w)).length;
    const union        = new Set([...newTokens, ...existingTokens]).size;
    const jaccard      = union === 0 ? 0 : intersection / union;
    if (jaccard > 0.55) return true;

    // Pass 2: Key-entity n-gram overlap; 3+ shared meaningful bigrams → duplicate
    const existingBigrams = bigrams(existingTokens);
    const bigramOverlap   = [...newBigrams].filter(bg => existingBigrams.has(bg)).length;
    if (bigramOverlap >= 3) return true;
  }

  return false;
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