/**
 * Resolution signer portal (#91).
 *
 * External signers log in with SEP-10 like everyone else. What makes a
 * wallet a signer of a market is the spec committed at creation (ADR 0001),
 * never the current environment: RESOLUTION_SIGNERS can change after a market
 * exists. The stored spec is trusted only after it re-hashes to
 * Market.resolutionHash and to the resolution_hash the market holds on-chain.
 *
 * The API coordinates; the resolver contract still enforces membership, the
 * close time and per-outcome uniqueness. The backend never holds a signer's
 * key: it prepares a simulated transaction whose source is the signer, so
 * source-account auth satisfies `signer.require_auth()`, and later broadcasts
 * the transaction the signer signed, only if it is exactly the prepared one.
 */
import { Keypair, TransactionBuilder, type xdr } from '@stellar/stellar-sdk';
import type { Market } from '@prisma/client';
import { Prisma as PrismaNs } from '@prisma/client';
import { config } from '../config';
import { CONTRACTS } from '../config/contracts';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { resolutionHash, validateResolutionSpec, type ResolutionSpecJson } from '../lib/resolution-spec';
import { sha256Hex } from '../utils/hash.util';
import { AppError } from '../middlewares/error.middleware';
import { baseOptions, ResolverClient, rpcServer } from './stellar/clients';
import { contractErrorName } from './stellar/errors';
import { getOnChainMarket, Outcomes, resolverState } from './chain.service';
import { fetchIpfsBytes } from './ipfs.service';

export type SignerSpec = Extract<ResolutionSpecJson, { kind: 'signers' }>;
export type AttestOutcome = 'YES' | 'NO';

export interface SignerContext {
  market: Market;
  spec: SignerSpec;
  onChainMarketId: bigint;
}

/** What the service needs from the outside world; tests replace these. */
export interface SignerPortalDeps {
  /** The structural subset of the resolver binding used to build an attest. */
  clientFor(wallet: string): { attest: ResolverClient['attest'] };
  onChainResolutionHash(onChainMarketId: bigint): Promise<string>;
  resolverState(onChainMarketId: bigint): Promise<string>;
  fetchQuestion(cid: string): Promise<Buffer>;
  rpc: {
    sendTransaction(tx: ReturnType<typeof TransactionBuilder.fromXDR>): Promise<any>;
    getTransaction(hash: string): Promise<any>;
  };
  now(): Date;
  /** How long submit waits for the ledger before answering 202. */
  confirmTimeoutMs: number;
  pollMs: number;
}

const defaultDeps: SignerPortalDeps = {
  clientFor: (wallet) =>
    new ResolverClient({ ...baseOptions(CONTRACTS.resolver), publicKey: wallet }),
  onChainResolutionHash: async (id) => Buffer.from((await getOnChainMarket(id)).resolution_hash).toString('hex'),
  resolverState: async (id) => (await resolverState(id)).tag,
  fetchQuestion: (cid) => fetchIpfsBytes(cid),
  rpc: rpcServer as unknown as SignerPortalDeps['rpc'],
  now: () => new Date(),
  confirmTimeoutMs: 30_000,
  pollMs: 1_000,
};

let deps: SignerPortalDeps = defaultDeps;

/** Test seam. Returns a function that restores the previous dependencies. */
export function setSignerPortalDeps(next: Partial<SignerPortalDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => {
    deps = previous;
  };
}

/** Seconds a prepared attest transaction stays valid. */
export const PREPARE_TTL_SECONDS = 300;

const toEnum = (outcome: AttestOutcome) => (outcome === 'YES' ? Outcomes.Yes : Outcomes.No);

// ─── Authorization ───────────────────────────────────────────────────────

/**
 * The market's committed signer spec, verified three ways: the stored JSON
 * re-hashes to Market.resolutionHash, and that equals the market's on-chain
 * resolution_hash. Any disagreement is SPEC_MISMATCH, and nothing is served.
 */
export async function committedSignerSpec(marketId: string): Promise<SignerContext> {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market) throw new AppError(404, 'MARKET_NOT_FOUND', 'Market not found');
  if (market.onChainMarketId === null || market.onChainMarketId === undefined) {
    throw new AppError(409, 'MARKET_NOT_ON_CHAIN', 'This market has not been created on-chain');
  }
  if (!market.resolutionSpec || !market.resolutionHash) {
    throw new AppError(409, 'SPEC_NOT_COMMITTED', 'This market has no committed resolution spec');
  }

  const stored = market.resolutionSpec as unknown as ResolutionSpecJson;
  let rehashed: string;
  try {
    validateResolutionSpec(stored);
    rehashed = resolutionHash(stored).toString('hex');
  } catch {
    throw new AppError(409, 'SPEC_MISMATCH', 'The stored resolution spec cannot be verified');
  }
  if (rehashed !== market.resolutionHash.toLowerCase()) {
    throw new AppError(409, 'SPEC_MISMATCH', 'The stored resolution spec does not match its committed hash');
  }
  const onChain = (await deps.onChainResolutionHash(market.onChainMarketId)).toLowerCase();
  if (onChain !== rehashed) {
    throw new AppError(409, 'SPEC_MISMATCH', 'The stored resolution spec does not match the on-chain resolution hash');
  }
  if (stored.kind !== 'signers') {
    throw new AppError(409, 'NOT_A_SIGNER_MARKET', 'This market resolves from a price oracle, not signers');
  }
  return { market, spec: stored, onChainMarketId: market.onChainMarketId };
}

/** 403 NOT_A_SIGNER unless `wallet` is in the market's committed signer set. */
export async function assertMarketSigner(marketId: string, wallet: string): Promise<SignerContext> {
  const ctx = await committedSignerSpec(marketId);
  if (!ctx.spec.signers.includes(wallet)) {
    throw new AppError(403, 'NOT_A_SIGNER', 'This wallet is not a resolution signer for this market');
  }
  return ctx;
}

// ─── Listing ─────────────────────────────────────────────────────────────

export interface AwaitingMarket {
  marketId: string;
  onChainMarketId: string;
  question: string;
  closedAt: Date;
  resolutionSource: string | null;
  resolverState: string;
  /** SPEC_NOT_REVEALED while the signer spec has not been registered on the resolver. */
  blockedReason: 'SPEC_NOT_REVEALED' | null;
  preparedOutcomes: AttestOutcome[];
}

const CANDIDATE_LIMIT = 200;
const STATE_CONCURRENCY = 5;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Markets that closed, name `wallet` in their committed signer set, are not
 * finalized on the resolver and that this signer has not attested to yet.
 * The set comes from JSONB containment (GIN-indexed), the resolver state from
 * the chain with bounded concurrency.
 */
export async function listAwaiting(
  wallet: string,
  page: { page: number; limit: number },
): Promise<{ items: AwaitingMarket[]; total: number }> {
  const containment = JSON.stringify({ kind: 'signers', signers: [wallet] });
  const now = deps.now();
  const candidates = await prisma.$queryRaw<
    Array<{ id: string; question: string; onChainMarketId: bigint; expiryTimestamp: Date; resolutionOracle: string | null }>
  >(PrismaNs.sql`
    SELECT m."id", m."question", m."onChainMarketId", m."expiryTimestamp", m."resolutionOracle"
    FROM "markets" m
    WHERE m."onChainMarketId" IS NOT NULL
      AND m."resolutionSpec" @> ${containment}::jsonb
      AND m."expiryTimestamp" <= ${now}
      AND m."status" NOT IN ('RESOLVED', 'CANCELLED')
      AND NOT EXISTS (
        SELECT 1 FROM "signer_attestations" a
        WHERE a."marketId" = m."id" AND a."signer" = ${wallet} AND a."status" = 'CONFIRMED'
      )
    ORDER BY m."expiryTimestamp" ASC
    LIMIT ${CANDIDATE_LIMIT}
  `);

  const states = await mapLimited(candidates, STATE_CONCURRENCY, async (m) => {
    try {
      return await deps.resolverState(m.onChainMarketId);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, marketId: m.id }, 'Signer portal: resolver state unavailable');
      return null;
    }
  });

  const prepared = candidates.length
    ? await prisma.signerAttestation.findMany({
        where: { signer: wallet, marketId: { in: candidates.map((c) => c.id) }, status: { in: ['PREPARED', 'SUBMITTED'] } },
        select: { marketId: true, outcome: true },
      })
    : [];

  const awaiting: AwaitingMarket[] = [];
  candidates.forEach((m, i) => {
    const state = states[i];
    if (state === 'Finalized') return;
    awaiting.push({
      marketId: m.id,
      onChainMarketId: m.onChainMarketId.toString(),
      question: m.question,
      closedAt: m.expiryTimestamp,
      resolutionSource: m.resolutionOracle,
      // An unreadable state (RPC trouble) is shown as UNKNOWN rather than hiding the market.
      resolverState: state ?? 'UNKNOWN',
      blockedReason: state === 'Unconfigured' ? 'SPEC_NOT_REVEALED' : null,
      preparedOutcomes: prepared.filter((p) => p.marketId === m.id).map((p) => p.outcome as AttestOutcome),
    });
  });

  const start = (page.page - 1) * page.limit;
  return { items: awaiting.slice(start, start + page.limit), total: awaiting.length };
}

// ─── Evidence ────────────────────────────────────────────────────────────

export async function getEvidence(marketId: string, wallet: string) {
  const { market, spec, onChainMarketId } = await assertMarketSigner(marketId, wallet);
  if (!market.metaUri || !market.questionHash) {
    throw new AppError(409, 'QUESTION_NOT_PINNED', 'This market has no pinned question document');
  }
  const cid = market.metaUri.replace(/^ipfs:\/\//, '');

  let bytes: Buffer;
  try {
    bytes = await deps.fetchQuestion(cid);
  } catch (err) {
    if (err instanceof AppError && err.code === 'IPFS_RETRIEVAL_FAILED') throw err;
    throw new AppError(502, 'IPFS_RETRIEVAL_FAILED', 'Could not retrieve the question document', { cid });
  }
  // Never hand a signer bytes that do not match the commitment.
  if (sha256Hex(bytes) !== market.questionHash.toLowerCase()) {
    throw new AppError(502, 'IPFS_RETRIEVAL_FAILED', 'The retrieved question document does not match its committed hash', { cid });
  }
  let question: Record<string, unknown>;
  try {
    question = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AppError(502, 'IPFS_RETRIEVAL_FAILED', 'The question document is not valid JSON', { cid });
  }

  const traces = await prisma.reasoningTrace.findMany({
    where: { marketId: market.id, decisionType: 'RESOLUTION_ATTESTATION' },
    select: { id: true, agentType: true, ipfsCid: true, traceHash: true, onChainTraceId: true, verified: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  return {
    marketId: market.id,
    onChainMarketId: onChainMarketId.toString(),
    question,
    questionHash: market.questionHash,
    questionUri: market.metaUri,
    resolutionSource: (question.resolutionSource as string | null | undefined) ?? market.resolutionOracle ?? null,
    closeTime: Math.floor(market.expiryTimestamp.getTime() / 1000),
    spec,
    resolutionHash: market.resolutionHash,
    evidenceTraces: traces.map((t) => ({ ...t, url: `/api/v1/traces/${t.id}` })),
  };
}

// ─── Prepare ─────────────────────────────────────────────────────────────

export interface PreparedAttestation {
  xdr: string;
  networkPassphrase: string;
  validUntil: string;
  outcome: AttestOutcome;
}

const prepared = (row: { preparedXdr: string; validUntil: Date; outcome: string }): PreparedAttestation => ({
  xdr: row.preparedXdr,
  networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
  validUntil: row.validUntil.toISOString(),
  outcome: row.outcome as AttestOutcome,
});

/** Maps a simulation error from the resolver to an API error. */
function simulationError(text: string): AppError {
  const name = contractErrorName('resolver', text, text);
  switch (name) {
    case 'NotSigner':
      return new AppError(403, 'NOT_A_SIGNER', 'The resolver contract does not list this wallet as a signer');
    case 'AlreadyAttested':
      return new AppError(409, 'ALREADY_ATTESTED', 'This wallet already attested to this outcome');
    case 'MarketNotClosed':
      return new AppError(409, 'MARKET_NOT_CLOSED', 'The market has not closed yet');
    case 'AlreadyFinalized':
      return new AppError(409, 'ALREADY_FINALIZED', 'The market is already finalized');
    case 'MarketNotConfigured':
      return new AppError(409, 'SPEC_NOT_REVEALED', 'The resolution spec has not been registered on the resolver yet');
    default:
      return new AppError(422, 'SIMULATION_FAILED', 'The attest transaction failed simulation', { contractError: name });
  }
}

async function settleInFlight(row: { id: string; txHash: string | null; validUntil: Date }) {
  // A SUBMITTED row whose result we never saw: ask the network before deciding.
  if (!row.txHash) return null;
  const result = await deps.rpc.getTransaction(row.txHash).catch(() => null);
  if (!result || result.status === 'NOT_FOUND') {
    if (deps.now() < row.validUntil) {
      throw new AppError(409, 'ATTESTATION_IN_FLIGHT', 'An attestation for this outcome was already broadcast; wait for it to confirm');
    }
    await prisma.signerAttestation.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'EXPIRED_UNCONFIRMED' } });
    return null;
  }
  if (result.status === 'SUCCESS') {
    await prisma.signerAttestation.update({ where: { id: row.id }, data: { status: 'CONFIRMED', ledger: result.ledger ?? null } });
    return 'CONFIRMED' as const;
  }
  await prisma.signerAttestation.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'TX_FAILED' } });
  return null;
}

export async function prepareAttestation(
  marketId: string,
  wallet: string,
  outcome: AttestOutcome,
  opts: { allowConflict?: boolean } = {},
): Promise<PreparedAttestation> {
  const { market, onChainMarketId } = await assertMarketSigner(marketId, wallet);

  const state = await deps.resolverState(onChainMarketId);
  if (state === 'Unconfigured') {
    throw new AppError(409, 'SPEC_NOT_REVEALED', 'The resolution spec has not been registered on the resolver yet');
  }
  if (state === 'Finalized') {
    throw new AppError(409, 'ALREADY_FINALIZED', 'The market is already finalized');
  }

  const mine = await prisma.signerAttestation.findMany({ where: { onChainMarketId, signer: wallet } });
  for (const row of mine.filter((r) => r.status === 'SUBMITTED')) {
    if ((await settleInFlight(row)) === 'CONFIRMED') row.status = 'CONFIRMED';
  }
  const confirmed = mine.filter((r) => r.status === 'CONFIRMED');
  if (confirmed.some((r) => r.outcome === outcome)) {
    throw new AppError(409, 'ALREADY_ATTESTED', 'This wallet already attested to this outcome');
  }
  // The contract would accept an attestation for the other outcome. The API
  // does not help a signer equivocate unless explicitly asked.
  if (confirmed.length > 0 && !opts.allowConflict) {
    throw new AppError(409, 'CONFLICTING_ATTESTATION', `This wallet already attested ${confirmed[0].outcome}; attesting ${outcome} as well would be a conflicting attestation. Pass allowConflict=true to prepare it anyway.`, {
      attested: confirmed.map((r) => r.outcome),
    });
  }

  // Two prepares for the same outcome return the same live transaction, so a
  // second sequence number is never consumed.
  const existing = mine.find((r) => r.outcome === outcome);
  if (existing && existing.status === 'PREPARED' && existing.validUntil > deps.now()) {
    return prepared(existing);
  }

  let tx: any;
  try {
    tx = await deps.clientFor(wallet).attest(
      { market_id: onChainMarketId, signer: wallet, outcome: toEnum(outcome) },
      { timeoutInSeconds: PREPARE_TTL_SECONDS } as never,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/account not found|not found.*account|404/i.test(message)) {
      throw new AppError(409, 'SIGNER_ACCOUNT_NOT_FOUND', 'The signer account does not exist on this network; fund it first');
    }
    const named = contractErrorName('resolver', err);
    if (named) throw simulationError(message);
    logger.error({ err: message, marketId: market.id }, 'Signer portal: building the attest transaction failed');
    throw new AppError(502, 'PREPARE_FAILED', 'Could not build the attest transaction');
  }

  const simError = (tx.simulation as { error?: string } | undefined)?.error;
  if (simError) throw simulationError(simError);

  // The signer is the source account, so only the source signs: no Soroban
  // authorization entries for anyone else.
  let others: string[] = [];
  try {
    others = tx.needsNonInvokerSigningBy();
  } catch {
    others = [];
  }
  if (others.length > 0) {
    throw new AppError(422, 'EXTRA_SIGNERS_REQUIRED', 'The attest transaction needs authorization from accounts other than the signer');
  }
  if (!tx.built) throw new AppError(502, 'PREPARE_FAILED', 'Simulation did not produce a transaction');

  const maxTime = Number(tx.built.timeBounds?.maxTime ?? 0);
  const validUntil = maxTime > 0
    ? new Date(maxTime * 1000)
    : new Date(deps.now().getTime() + PREPARE_TTL_SECONDS * 1000);
  const data = {
    marketId: market.id,
    onChainMarketId,
    signer: wallet,
    outcome,
    status: 'PREPARED',
    preparedXdr: tx.toXDR() as string,
    preparedHash: (tx.built.hash() as Buffer).toString('hex'),
    validUntil,
    txHash: null,
    ledger: null,
    error: null,
  };
  const row = await prisma.signerAttestation.upsert({
    where: { onChainMarketId_signer_outcome: { onChainMarketId, signer: wallet, outcome } },
    create: data,
    update: data,
  });
  return prepared(row);
}

// ─── Submit ──────────────────────────────────────────────────────────────

/** Name of the transaction result code in an RPC errorResult, if decodable. */
function resultCode(errorResult: unknown): string | null {
  try {
    const result = errorResult as xdr.TransactionResult;
    return result.result().switch().name;
  } catch {
    return null;
  }
}

export interface SubmitResult {
  status: 'CONFIRMED' | 'SUBMITTED';
  outcome: AttestOutcome;
  txHash: string;
  ledger: number | null;
}

export async function submitAttestation(marketId: string, wallet: string, signedXdr: string): Promise<SubmitResult> {
  const { market } = await assertMarketSigner(marketId, wallet);

  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, config.STELLAR_NETWORK_PASSPHRASE);
  } catch {
    throw new AppError(400, 'INVALID_SIGNED_XDR', 'xdr is not a valid transaction envelope for this network');
  }
  if ('innerTransaction' in parsed) {
    throw new AppError(400, 'INVALID_SIGNED_XDR', 'Fee-bump envelopes are not accepted');
  }
  // The hash covers the body and the network, not the signatures.
  const hash = parsed.hash().toString('hex');

  const row = await prisma.signerAttestation.findFirst({ where: { marketId: market.id, signer: wallet, preparedHash: hash } });
  if (!row) {
    throw new AppError(409, 'PREPARED_TX_MISMATCH', 'This is not a transaction prepared for this market and wallet');
  }

  if (row.status === 'CONFIRMED') {
    return { status: 'CONFIRMED', outcome: row.outcome as AttestOutcome, txHash: row.txHash ?? hash, ledger: row.ledger ?? null };
  }
  if (row.status === 'SUBMITTED') {
    return { status: 'SUBMITTED', outcome: row.outcome as AttestOutcome, txHash: row.txHash ?? hash, ledger: null };
  }
  if (row.status === 'FAILED') {
    throw new AppError(409, 'PREPARED_TX_FAILED', 'This prepared transaction already failed; prepare a new one');
  }
  if (row.validUntil <= deps.now()) {
    throw new AppError(410, 'PREPARED_TX_EXPIRED', 'The prepared transaction has expired; prepare a new one');
  }

  // At least one signature must be the wallet's own, over this exact hash.
  const keypair = Keypair.fromPublicKey(wallet);
  const signedByWallet = parsed.signatures.some((s) => {
    try {
      return s.hint().equals(keypair.signatureHint()) && keypair.verify(parsed.hash(), s.signature());
    } catch {
      return false;
    }
  });
  if (!signedByWallet) {
    throw new AppError(400, 'SIGNATURE_INVALID', 'The transaction is not signed by the signer wallet');
  }

  // One submit wins; a concurrent duplicate sees SUBMITTED and returns.
  const claim = await prisma.signerAttestation.updateMany({
    where: { id: row.id, status: 'PREPARED' },
    data: { status: 'SUBMITTED', txHash: hash },
  });
  if (claim.count !== 1) {
    return { status: 'SUBMITTED', outcome: row.outcome as AttestOutcome, txHash: hash, ledger: null };
  }

  const fail = async (error: string) => {
    await prisma.signerAttestation.update({ where: { id: row.id }, data: { status: 'FAILED', error } });
  };

  let sent: any;
  try {
    sent = await deps.rpc.sendTransaction(parsed);
  } catch (err) {
    await prisma.signerAttestation.update({ where: { id: row.id }, data: { status: 'PREPARED', txHash: null } });
    logger.warn({ err: err instanceof Error ? err.message : err, marketId: market.id }, 'Signer portal: broadcast failed');
    throw new AppError(502, 'BROADCAST_FAILED', 'The transaction could not be sent to the network');
  }
  if (sent.status === 'TRY_AGAIN_LATER') {
    await prisma.signerAttestation.update({ where: { id: row.id }, data: { status: 'PREPARED', txHash: null } });
    throw new AppError(503, 'NETWORK_BUSY', 'The network asked to try again later');
  }
  if (sent.status === 'ERROR') {
    const code = resultCode(sent.errorResult);
    if (code === 'txBadSeq') {
      await fail('STALE_SEQUENCE');
      throw new AppError(409, 'STALE_SEQUENCE', 'The signer account sequence changed after preparing; prepare a new transaction');
    }
    await fail(code ?? 'BROADCAST_REJECTED');
    throw new AppError(422, 'BROADCAST_REJECTED', 'The network rejected the transaction', { resultCode: code });
  }

  const deadline = Date.now() + deps.confirmTimeoutMs;
  for (;;) {
    const result = await deps.rpc.getTransaction(hash);
    if (result.status === 'SUCCESS') {
      await prisma.signerAttestation.update({
        where: { id: row.id },
        data: { status: 'CONFIRMED', txHash: hash, ledger: result.ledger ?? null, error: null },
      });
      return { status: 'CONFIRMED', outcome: row.outcome as AttestOutcome, txHash: hash, ledger: result.ledger ?? null };
    }
    if (result.status === 'FAILED') {
      const code = resultCode(result.resultXdr);
      await fail(code ?? 'TX_FAILED');
      throw new AppError(422, 'ATTESTATION_FAILED', 'The attest transaction failed on-chain', { resultCode: code, txHash: hash });
    }
    if (Date.now() >= deadline) {
      // Left SUBMITTED: a later prepare settles it against the network.
      return { status: 'SUBMITTED', outcome: row.outcome as AttestOutcome, txHash: hash, ledger: null };
    }
    await new Promise((r) => setTimeout(r, deps.pollMs));
  }
}

// ─── Progress ────────────────────────────────────────────────────────────

export async function getProgress(marketId: string, wallet: string) {
  const { market, spec, onChainMarketId } = await assertMarketSigner(marketId, wallet);

  const rows = await prisma.signerAttestation.findMany({
    where: { onChainMarketId, status: 'CONFIRMED' },
    orderBy: { updatedAt: 'asc' },
  });
  const counts = { YES: 0, NO: 0 };
  for (const r of rows) counts[r.outcome as AttestOutcome] += 1;

  const bySigner = new Map<string, Set<string>>();
  for (const r of rows) bySigner.set(r.signer, (bySigner.get(r.signer) ?? new Set()).add(r.outcome));
  const equivocators = [...bySigner.entries()].filter(([, outcomes]) => outcomes.size > 1).map(([signer]) => signer);

  const proposalEvent = await prisma.chainEvent.findFirst({
    where: {
      contractName: 'resolver',
      eventName: 'ResolutionProposed',
      params: { path: ['market_id'], equals: onChainMarketId.toString() },
    },
    orderBy: [{ ledger: 'desc' }, { id: 'desc' }],
  });
  let proposal: { outcome: AttestOutcome; proposedAt: string } | null = null;
  if (proposalEvent) {
    const params = proposalEvent.params as { outcome?: { tag?: string }; proposed_at?: string };
    const tag = params.outcome?.tag;
    if (tag === 'Yes' || tag === 'No') proposal = { outcome: tag === 'Yes' ? 'YES' : 'NO', proposedAt: String(params.proposed_at ?? '') };
  }

  let state: string | null = null;
  try {
    state = await deps.resolverState(onChainMarketId);
  } catch {
    state = null;
  }

  const reached = (counts.YES >= spec.threshold ? 1 : 0) + (counts.NO >= spec.threshold ? 1 : 0) > 0;
  return {
    marketId: market.id,
    onChainMarketId: onChainMarketId.toString(),
    threshold: spec.threshold,
    signers: spec.signers,
    counts,
    countsSource: 'api-observed' as const,
    attestedBy: rows.map((r) => ({ signer: r.signer, outcome: r.outcome, txHash: r.txHash, ledger: r.ledger })),
    thresholdReached: reached || proposal !== null,
    // Signers split between outcomes, and anyone who attested both: surfaced, not hidden.
    split: counts.YES > 0 && counts.NO > 0,
    equivocators,
    proposal,
    // A proposal that the API-observed counts cannot explain means attestations happened outside the API.
    attestationsOutsideApi: proposal !== null && counts[proposal.outcome] < spec.threshold,
    resolverState: state,
  };
}
