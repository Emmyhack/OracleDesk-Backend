/**
 * Dispute monitor (#92).
 *
 * A signer-mode market is not final when signers agree: the resolver stores a
 * proposal and the guardian (the resolver admin) may cancel it during the
 * dispute window. That only helps if someone notices, so for every
 * ResolutionProposed this module
 *
 *   1. records a DisputeReview (from the indexer, idempotent per event id),
 *   2. re-evaluates the outcome independently from the committed question
 *      document and resolution source, without the proposer's evidence,
 *   3. compares it with the proposal (AGREE | DISAGREE | INSUFFICIENT),
 *   4. raises deduplicated, escalating alerts with the time left on the
 *      *ledger* clock (contract time is ledger time, not server time),
 *   5. builds unsigned cancel_proposal / guardian_void_market transactions for
 *      the guardian to sign. It never cancels anything itself.
 */
import { Prisma } from '@prisma/client';
import type { DisputeReview, Market } from '@prisma/client';
import { config } from '../config';
import { CONTRACTS } from '../config/contracts';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { resolutionHash, validateResolutionSpec, type ResolutionSpecJson } from '../lib/resolution-spec';
import { canonicalJson, sha256Hex } from '../utils/hash.util';
import { AppError } from '../middlewares/error.middleware';
import { AlertService, type Alert, type AlertLevel } from './alerts.service';
import { createLlmEvaluator, type Evaluator, type EvidenceItem, type QuestionDoc } from './dispute-evaluator.service';
import { fetchIpfsBytes } from './ipfs.service';
import { agentSigner, baseOptions, readClients, ResolverClient, rpcServer } from './stellar/clients';
import { contractErrorName } from './stellar/errors';
import { resolverState } from './chain.service';

export type Verdict = 'PENDING' | 'AGREE' | 'DISAGREE' | 'INSUFFICIENT' | 'ERROR';

/** A signer-mode proposal event, as stored by the indexer. */
export interface ProposalEvent {
  id: string;
  params: Record<string, any>;
}

export interface MonitorDeps {
  evaluator: Evaluator;
  alerts: AlertService;
  /** Ledger-time clock: remaining window time is measured against this, not server time. */
  clock: () => Date | Promise<Date>;
}

const outcomeLabel = (o: unknown): 'YES' | 'NO' | null => {
  const tag = o && typeof o === 'object' && 'tag' in o ? (o as { tag: string }).tag : o;
  return tag === 'Yes' ? 'YES' : tag === 'No' ? 'NO' : null;
};

interface ReviewNotes {
  items?: EvidenceItem[];
  /** Why the verdict is what it is, when it is not the plain comparison. */
  reason?: string;
  error?: string;
  /** A failure worth retrying (provider down), as opposed to a finding. */
  transient?: boolean;
  attempts?: number;
}

const MAX_EVALUATION_ATTEMPTS = 6;

// ─── Ledger time ─────────────────────────────────────────────────────────

export interface LedgerTime {
  ledgerTime: Date;
  serverTime: Date;
  source: 'rpc' | 'indexer' | 'server';
}

/**
 * The latest ledger close time: from RPC, else from the newest indexed event,
 * else (flagged) the server clock.
 */
export async function ledgerTime(): Promise<LedgerTime> {
  const serverTime = new Date();
  try {
    const latest = await rpcServer.getLatestLedger();
    const seconds = Number((latest as { closeTime?: string | number }).closeTime);
    if (Number.isFinite(seconds) && seconds > 0) return { ledgerTime: new Date(seconds * 1000), serverTime, source: 'rpc' };
  } catch {
    // fall through to the indexer
  }
  try {
    const newest = await prisma.chainEvent.findFirst({ orderBy: { ledger: 'desc' }, select: { ledgerClosedAt: true } });
    if (newest) return { ledgerTime: newest.ledgerClosedAt, serverTime, source: 'indexer' };
  } catch {
    // fall through to the server clock
  }
  return { ledgerTime: serverTime, serverTime, source: 'server' };
}

// ─── Recording proposals (called by the indexer) ─────────────────────────

/** The market's signer spec, only if it re-hashes to the hash committed in Market.resolutionHash. */
export function verifiedSignerSpec(market: Pick<Market, 'resolutionSpec' | 'resolutionHash'> | null):
  | { spec: Extract<ResolutionSpecJson, { kind: 'signers' }> }
  | { error: string } {
  if (!market) return { error: 'UNKNOWN_MARKET' };
  if (!market.resolutionSpec || !market.resolutionHash) return { error: 'SPEC_NOT_COMMITTED' };
  const spec = market.resolutionSpec as unknown as ResolutionSpecJson;
  try {
    validateResolutionSpec(spec);
    if (resolutionHash(spec).toString('hex') !== market.resolutionHash.toLowerCase()) return { error: 'SPEC_HASH_MISMATCH' };
  } catch {
    return { error: 'SPEC_HASH_MISMATCH' };
  }
  if (spec.kind !== 'signers') return { error: 'NOT_A_SIGNER_MARKET' };
  return { spec };
}

/**
 * Inserts the review for one ResolutionProposed event. Idempotent: the event id
 * is unique, so replays and concurrent indexers create one row. A proposal on a
 * market whose spec cannot be verified is stored as ERROR, because that is
 * itself suspicious.
 */
export async function recordProposal(event: ProposalEvent): Promise<{ review: DisputeReview; created: boolean }> {
  const existing = await prisma.disputeReview.findUnique({ where: { proposalEventId: event.id } });
  if (existing) return { review: existing, created: false };

  const onChainMarketId = BigInt(event.params.market_id);
  const proposed = outcomeLabel(event.params.outcome);
  const proposedAt = BigInt(event.params.proposed_at);
  const market = await prisma.market.findUnique({ where: { onChainMarketId } });
  const checked = verifiedSignerSpec(market);

  const data: Prisma.DisputeReviewUncheckedCreateInput = {
    onChainMarketId,
    proposalEventId: event.id,
    proposedOutcome: proposed ?? 'UNKNOWN',
    proposedAt,
    windowEndsAt: 'spec' in checked ? proposedAt + BigInt(checked.spec.disputeWindow) : null,
    verdict: 'spec' in checked ? 'PENDING' : 'ERROR',
    ...('error' in checked ? { evidence: { error: checked.error } as Prisma.InputJsonValue } : {}),
  };
  try {
    return { review: await prisma.disputeReview.create({ data }), created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.disputeReview.findUnique({ where: { proposalEventId: event.id } });
      if (winner) return { review: winner, created: false };
    }
    throw err;
  }
}

/** ResolutionFinalized: the proposal can no longer be cancelled. */
export async function recordFinalized(event: ProposalEvent): Promise<number> {
  const { count } = await prisma.disputeReview.updateMany({
    where: { onChainMarketId: BigInt(event.params.market_id), resolvedAs: null },
    data: { resolvedAs: 'FINALIZED' },
  });
  return count;
}

// ─── Alert policy ────────────────────────────────────────────────────────

/** Remaining dispute window in seconds on the ledger clock; null when it cannot be known. */
export function windowRemaining(review: Pick<DisputeReview, 'windowEndsAt'>, now: Date): number | null {
  if (review.windowEndsAt === null || review.windowEndsAt === undefined) return null;
  return Number(review.windowEndsAt) - Math.floor(now.getTime() / 1000);
}

export const ESCALATE_BELOW_FRACTION = 0.25;

/**
 * Which alert levels this review needs *now*. Pure, so the cron can call it
 * repeatedly: AlertService sends only what has not been delivered.
 *
 *   window already over            → INFO only
 *   ERROR / DISAGREE               → CRITICAL
 *   INSUFFICIENT                   → WARN, plus CRITICAL under 25% of the window left (unless acknowledged)
 *   AGREE                          → INFO only when no second opinion exists on-chain
 *   proposal found only by polling → WARN
 */
export function requiredLevels(
  review: Pick<DisputeReview, 'verdict' | 'windowEndsAt' | 'proposedAt' | 'acknowledgedAt' | 'proposalEventId'>,
  now: Date,
  soleAgentSigner: boolean,
): AlertLevel[] {
  const remaining = windowRemaining(review, now);
  if (remaining !== null && remaining <= 0) return ['INFO'];

  const levels = new Set<AlertLevel>();
  if (review.proposalEventId.startsWith('missed:')) levels.add('WARN');
  switch (review.verdict) {
    case 'ERROR':
    case 'DISAGREE':
      levels.add('CRITICAL');
      break;
    case 'INSUFFICIENT': {
      levels.add('WARN');
      const total = review.windowEndsAt !== null && review.proposedAt !== null ? Number(review.windowEndsAt - review.proposedAt) : null;
      if (!review.acknowledgedAt && remaining !== null && total !== null && total > 0 && remaining < total * ESCALATE_BELOW_FRACTION) {
        levels.add('CRITICAL');
      }
      break;
    }
    case 'AGREE':
      if (soleAgentSigner) levels.add('INFO');
      break;
    default:
      break;
  }
  return (['INFO', 'WARN', 'CRITICAL'] as AlertLevel[]).filter((l) => levels.has(l));
}

function titleFor(review: DisputeReview, level: AlertLevel, expired: boolean): string {
  if (expired) return `Resolution proposal for market ${review.onChainMarketId} observed after its dispute window ended`;
  if (review.proposalEventId.startsWith('missed:')) return `Resolution proposal exists for market ${review.onChainMarketId} but its event was missed`;
  switch (review.verdict) {
    case 'DISAGREE':
      return `Independent review DISAGREES with proposed outcome ${review.proposedOutcome} for market ${review.onChainMarketId}`;
    case 'ERROR':
      return `Resolution proposed on market ${review.onChainMarketId}, whose spec or question could not be verified`;
    case 'INSUFFICIENT':
      return level === 'CRITICAL'
        ? `Dispute window closing: proposed outcome ${review.proposedOutcome} for market ${review.onChainMarketId} is still unconfirmed`
        : `Independent review could not confirm proposed outcome ${review.proposedOutcome} for market ${review.onChainMarketId}`;
    default:
      return `Resolution proposed for market ${review.onChainMarketId}: ${review.proposedOutcome} (no second opinion on-chain)`;
  }
}

function buildAlert(review: DisputeReview, market: Market | null, level: AlertLevel, now: Date): Alert {
  const remaining = windowRemaining(review, now);
  const expired = remaining !== null && remaining <= 0;
  const notes = (review.evidence ?? {}) as ReviewNotes;
  const detail = [
    review.independentOutcome ? `Independent outcome: ${review.independentOutcome} (confidence ${review.confidence?.toFixed(2)}).` : null,
    notes.reason ? `Note: ${notes.reason}.` : null,
    notes.error ? `Problem: ${notes.error}.` : null,
    config.RESOLVER_GUARDIAN_ADDRESS
      ? null
      : 'RESOLVER_GUARDIAN_ADDRESS is not configured, so cancel/void transactions cannot be built until it is set.',
  ].filter(Boolean).join(' ');
  return {
    level,
    title: titleFor(review, level, expired),
    marketId: market?.id ?? '',
    onChainMarketId: review.onChainMarketId.toString(),
    proposedOutcome: review.proposedOutcome,
    verdict: review.verdict,
    windowRemainingSecs: remaining,
    links: {
      market: market ? `/api/v1/markets/${market.id}` : `/api/v1/markets/on-chain/${review.onChainMarketId}`,
      cancelTx: `/api/v1/admin/disputes/${review.id}/cancel-tx`,
    },
    ...(detail ? { detail } : {}),
  };
}

function isSoleAgentSigner(spec: { signers: string[]; threshold: number } | null): boolean {
  if (!spec || spec.threshold !== 1 || spec.signers.length !== 1) return false;
  return spec.signers[0] === agentSigner().publicKey;
}

/** Sends whatever alerts this review currently requires. */
export async function dispatchAlerts(review: DisputeReview, deps: Pick<MonitorDeps, 'alerts' | 'clock'>): Promise<AlertLevel[]> {
  const market = await prisma.market.findUnique({ where: { onChainMarketId: review.onChainMarketId } });
  const checked = verifiedSignerSpec(market);
  const now = await deps.clock();
  const levels = requiredLevels(review, now, 'spec' in checked && isSoleAgentSigner(checked.spec));
  const sent: AlertLevel[] = [];
  for (const level of levels) {
    const delivered = await deps.alerts.send(review.id, buildAlert(review, market, level, now));
    if (delivered.length > 0) sent.push(level);
  }
  return sent;
}

// ─── Independent review ──────────────────────────────────────────────────

function notesOf(review: DisputeReview): ReviewNotes {
  return (review.evidence ?? {}) as ReviewNotes;
}

async function save(id: string, data: Prisma.DisputeReviewUncheckedUpdateInput): Promise<DisputeReview> {
  return prisma.disputeReview.update({ where: { id }, data });
}

/**
 * Evaluates one review and raises its alerts. Safe to call again: a finished
 * review only re-dispatches alerts (which dedupe), and a transient failure is
 * retried a bounded number of times.
 */
export async function reviewProposal(id: string, deps: MonitorDeps): Promise<DisputeReview> {
  let review = await prisma.disputeReview.findUnique({ where: { id } });
  if (!review) throw new AppError(404, 'DISPUTE_NOT_FOUND', 'Dispute review not found');
  if (review.resolvedAs) return review;

  const notes = notesOf(review);
  const retry = review.verdict === 'INSUFFICIENT' && notes.transient === true && (notes.attempts ?? 0) < MAX_EVALUATION_ATTEMPTS;
  if (review.verdict !== 'PENDING' && !retry) {
    await dispatchAlerts(review, deps);
    return review;
  }

  const market = await prisma.market.findUnique({ where: { onChainMarketId: review.onChainMarketId } });
  const checked = verifiedSignerSpec(market);
  if ('error' in checked || !market) {
    review = await save(id, { verdict: 'ERROR', evidence: { error: 'error' in checked ? checked.error : 'UNKNOWN_MARKET' } as Prisma.InputJsonValue });
    await dispatchAlerts(review, deps);
    return review;
  }

  const attempts = (notes.attempts ?? 0) + 1;
  let doc: QuestionDoc;
  try {
    if (!market.metaUri || !market.questionHash) throw new AppError(409, 'QUESTION_NOT_PINNED', 'no pinned question');
    const bytes = await fetchIpfsBytes(market.metaUri.replace(/^ipfs:\/\//, ''));
    if (sha256Hex(bytes) !== market.questionHash.toLowerCase()) {
      // Tampered or wrong document: not something to retry.
      review = await save(id, { verdict: 'ERROR', evidence: { error: 'QUESTION_HASH_MISMATCH' } as Prisma.InputJsonValue });
      await dispatchAlerts(review, deps);
      return review;
    }
    doc = JSON.parse(bytes.toString('utf8')) as QuestionDoc;
  } catch (err) {
    const reason = err instanceof AppError ? err.code : 'QUESTION_UNAVAILABLE';
    review = await save(id, {
      verdict: 'INSUFFICIENT',
      evidence: { error: reason, transient: true, attempts } as Prisma.InputJsonValue,
    });
    await dispatchAlerts(review, deps);
    return review;
  }

  let result;
  try {
    result = await deps.evaluator.evaluate(doc, new Date(Number(doc.closeTime) * 1000));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, reviewId: id }, 'Dispute review: evaluation failed');
    review = await save(id, {
      verdict: 'INSUFFICIENT',
      evidence: { error: 'EVALUATION_FAILED', transient: true, attempts } as Prisma.InputJsonValue,
    });
    await dispatchAlerts(review, deps);
    return review;
  }

  const items = result.evidence;
  const threshold = config.DISPUTE_AGREE_MIN_CONFIDENCE;
  const confident = result.outcome !== null && result.confidence >= threshold;
  const known = review.proposedOutcome === 'YES' || review.proposedOutcome === 'NO';
  let verdict: Verdict = 'INSUFFICIENT';
  let reason: string | undefined;
  if (confident && known) {
    verdict = result.outcome === review.proposedOutcome ? 'AGREE' : 'DISAGREE';
  } else if (!known) {
    reason = 'the proposed outcome is unknown, so the independent result cannot be compared';
  }
  // Press coverage alone is not enough to confirm a high-value market: a
  // manipulated story would fool the signers and this review alike.
  if (verdict === 'AGREE' && (market.totalLiquidity ?? 0) >= config.DISPUTE_HIGH_VALUE_LIQUIDITY && !items.some((e) => e.cited && e.kind === 'primary')) {
    verdict = 'INSUFFICIENT';
    reason = 'high-value market: agreement needs a cited primary (non-news) source';
  }

  const stored: ReviewNotes = { items, ...(reason ? { reason } : {}), attempts };
  review = await save(id, {
    verdict,
    independentOutcome: result.outcome,
    confidence: result.confidence,
    evidence: stored as unknown as Prisma.InputJsonValue,
    evidenceHash: sha256Hex(canonicalJson(items)),
  });
  await dispatchAlerts(review, deps);
  return review;
}

// ─── Scheduling ──────────────────────────────────────────────────────────

let productionDeps: MonitorDeps | null = null;

/** Test seam: replaces the production dependencies (null restores them). */
export function setMonitorDeps(next: MonitorDeps | null): void {
  productionDeps = next;
}

export function monitorDeps(): MonitorDeps {
  productionDeps ??= {
    evaluator: createLlmEvaluator(),
    alerts: new AlertService(),
    clock: async () => (await ledgerTime()).ledgerTime,
  };
  return productionDeps;
}

/** Runs a review outside the caller's tick (never inside the indexer poll). */
export function scheduleReview(id: string, deps: () => MonitorDeps = monitorDeps): void {
  if (!config.DISPUTE_MONITOR_ENABLED) return;
  setImmediate(() => {
    reviewProposal(id, deps()).catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : err, reviewId: id }, 'Dispute review failed'),
    );
  });
}

/**
 * Every 5 minutes: review anything still pending, retry transient failures
 * and re-dispatch alerts, which is where INSUFFICIENT escalates to CRITICAL as
 * the window shrinks. Acknowledged reviews do not escalate.
 */
export async function escalateOpenReviews(deps: MonitorDeps = monitorDeps()): Promise<number> {
  const open = await prisma.disputeReview.findMany({ where: { resolvedAs: null }, orderBy: { createdAt: 'asc' }, take: 200 });
  let touched = 0;
  for (const review of open) {
    try {
      await reviewProposal(review.id, deps);
      touched++;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, reviewId: review.id }, 'Dispute escalation failed');
    }
  }
  return touched;
}

// ─── Polling fallback ────────────────────────────────────────────────────

export type FinalizeProbe = 'NO_PROPOSAL' | 'WINDOW_OPEN' | 'READY' | 'OTHER';

export interface ChainProbe {
  resolverState(onChainMarketId: bigint): Promise<string>;
  /** Simulates finalize_signers to learn whether a proposal exists and whether its window is open. */
  finalizeProbe(onChainMarketId: bigint): Promise<FinalizeProbe>;
}

export const chainProbe: ChainProbe = {
  resolverState: async (id) => (await resolverState(id)).tag,
  async finalizeProbe(id) {
    const tx = await readClients.resolver().finalize_signers({ market_id: id });
    const error = (tx.simulation as { error?: string } | undefined)?.error;
    if (!error) return 'READY';
    switch (contractErrorName('resolver', error, error)) {
      case 'NoProposal':
        return 'NO_PROPOSAL';
      case 'DisputeWindowOpen':
        return 'WINDOW_OPEN';
      default:
        return 'OTHER';
    }
  },
};

/**
 * Every 30 minutes: close reviews whose proposal is gone (finalized, or
 * cancelled, which emits no event) and find proposals whose event was missed.
 */
export async function pollProposals(
  deps: MonitorDeps = monitorDeps(),
  probe: ChainProbe = chainProbe,
): Promise<{ created: number; closed: number }> {
  const markets = await prisma.market.findMany({
    where: {
      onChainMarketId: { not: null },
      expiryTimestamp: { lt: new Date() },
      status: { notIn: ['RESOLVED', 'CANCELLED'] },
      resolutionSpec: { path: ['kind'], equals: 'signers' },
    },
    take: 500,
  });

  let created = 0;
  let closed = 0;
  for (const market of markets) {
    const id = market.onChainMarketId as bigint;
    try {
      const state = await probe.resolverState(id);
      const open = await prisma.disputeReview.findMany({ where: { onChainMarketId: id, resolvedAs: null } });
      if (state === 'Finalized') {
        const { count } = await prisma.disputeReview.updateMany({ where: { onChainMarketId: id, resolvedAs: null }, data: { resolvedAs: 'FINALIZED' } });
        closed += count;
        continue;
      }
      if (state !== 'SignersPending') continue;

      const finding = await probe.finalizeProbe(id);
      if (finding === 'NO_PROPOSAL') {
        const { count } = await prisma.disputeReview.updateMany({ where: { onChainMarketId: id, resolvedAs: null }, data: { resolvedAs: 'CANCELLED' } });
        closed += count;
        continue;
      }
      if ((finding === 'WINDOW_OPEN' || finding === 'READY') && open.length === 0) {
        const previous = await prisma.disputeReview.count({ where: { onChainMarketId: id, proposalEventId: { startsWith: `missed:${id}:` } } });
        const review = await prisma.disputeReview.create({
          data: { onChainMarketId: id, proposalEventId: `missed:${id}:${previous + 1}`, proposedOutcome: 'UNKNOWN', verdict: 'PENDING' },
        });
        created++;
        scheduleReview(review.id, () => deps);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, onChainMarketId: id.toString() }, 'Dispute polling: market check failed');
    }
  }
  return { created, closed };
}

// ─── Admin operations ────────────────────────────────────────────────────

export async function acknowledge(id: string, wallet: string): Promise<DisputeReview> {
  const review = await prisma.disputeReview.findUnique({ where: { id } });
  if (!review) throw new AppError(404, 'DISPUTE_NOT_FOUND', 'Dispute review not found');
  if (review.acknowledgedAt) return review;
  return prisma.disputeReview.update({ where: { id }, data: { acknowledgedBy: wallet, acknowledgedAt: new Date() } });
}

export async function listDisputes(opts: { status: 'open' | 'all'; page: number; limit: number }) {
  const where = opts.status === 'open' ? { resolvedAs: null } : {};
  const [rows, total, time] = await Promise.all([
    prisma.disputeReview.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (opts.page - 1) * opts.limit, take: opts.limit }),
    prisma.disputeReview.count({ where }),
    ledgerTime(),
  ]);
  const nowSeconds = Math.floor(time.ledgerTime.getTime() / 1000);
  return {
    total,
    ledgerTime: { ledger: time.ledgerTime.toISOString(), server: time.serverTime.toISOString(), source: time.source },
    items: rows.map((r) => ({
      ...r,
      windowRemainingSecs: r.windowEndsAt === null ? null : Number(r.windowEndsAt) - nowSeconds,
      windowRemainingServerSecs: r.windowEndsAt === null ? null : Number(r.windowEndsAt) - Math.floor(time.serverTime.getTime() / 1000),
    })),
  };
}

export interface GuardianTx {
  xdr: string;
  networkPassphrase: string;
  validUntil: string;
  guardian: string;
  kind: 'cancel_proposal' | 'guardian_void_market';
  onChainMarketId: string;
}

export interface GuardianDeps {
  clientFor(guardian: string): Pick<ResolverClient, 'cancel_proposal' | 'guardian_void_market'>;
}

let guardianDeps: GuardianDeps = {
  clientFor: (guardian) => new ResolverClient({ ...baseOptions(CONTRACTS.resolver), publicKey: guardian }),
};

/** Test seam. Returns a function that restores the previous factory. */
export function setGuardianDeps(next: GuardianDeps): () => void {
  const previous = guardianDeps;
  guardianDeps = next;
  return () => {
    guardianDeps = previous;
  };
}

function guardianSimulationError(text: string): AppError {
  if (/Error\(Auth|Unauthorized|require_auth/i.test(text) || contractErrorName('resolver', text, text) === 'Unauthorized') {
    return new AppError(409, 'GUARDIAN_MISMATCH', 'The simulation was not authorized: RESOLVER_GUARDIAN_ADDRESS is not the resolver admin');
  }
  switch (contractErrorName('resolver', text, text)) {
    case 'NoProposal':
      return new AppError(409, 'NO_PROPOSAL', 'The market has no pending proposal to cancel');
    case 'AlreadyFinalized':
      return new AppError(409, 'ALREADY_FINALIZED', 'The market is already finalized');
    default:
      return new AppError(422, 'SIMULATION_FAILED', 'The transaction failed simulation', { contractError: contractErrorName('resolver', text, text) });
  }
}

/**
 * An unsigned, simulated cancel_proposal or guardian_void_market whose source
 * is RESOLVER_GUARDIAN_ADDRESS. The guardian signs it in their own wallet.
 */
export async function buildGuardianTx(reviewId: string, kind: GuardianTx['kind']): Promise<GuardianTx> {
  const guardian = config.RESOLVER_GUARDIAN_ADDRESS;
  if (!guardian) {
    throw new AppError(503, 'GUARDIAN_NOT_CONFIGURED', 'RESOLVER_GUARDIAN_ADDRESS is not set');
  }
  const review = await prisma.disputeReview.findUnique({ where: { id: reviewId } });
  if (!review) throw new AppError(404, 'DISPUTE_NOT_FOUND', 'Dispute review not found');
  if (kind === 'cancel_proposal' && review.resolvedAs === 'FINALIZED') {
    throw new AppError(409, 'ALREADY_FINALIZED', 'The proposal was finalized and can no longer be cancelled');
  }

  const client = guardianDeps.clientFor(guardian);
  const args = { market_id: review.onChainMarketId };
  const options = { timeoutInSeconds: config.TREASURY_OP_TTL_SECONDS } as never;
  let tx: any;
  try {
    tx = kind === 'cancel_proposal' ? await client.cancel_proposal(args, options) : await client.guardian_void_market(args, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/account not found|not found.*account/i.test(message)) {
      throw new AppError(409, 'GUARDIAN_MISMATCH', 'The guardian account does not exist on this network');
    }
    throw guardianSimulationError(message);
  }
  const simError = (tx.simulation as { error?: string } | undefined)?.error;
  if (simError) throw guardianSimulationError(simError);
  if (!tx.built) throw new AppError(502, 'BUILD_FAILED', 'Simulation did not produce a transaction');

  const maxTime = Number(tx.built.timeBounds?.maxTime ?? 0);
  return {
    xdr: tx.toXDR() as string,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    validUntil: new Date(maxTime > 0 ? maxTime * 1000 : Date.now() + config.TREASURY_OP_TTL_SECONDS * 1000).toISOString(),
    guardian,
    kind,
    onChainMarketId: review.onChainMarketId.toString(),
  };
}
