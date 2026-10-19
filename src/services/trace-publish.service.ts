/**
 * Reasoning trace lifecycle after generation (#131):
 *   enqueue → pin the canonical JSON (traceHash = sha256(pinned bytes)) →
 *   wait for the market's on-chain id → reasoning_registry.publish_trace →
 *   confirmed by the indexer's TracePublished event → verified.
 * See src/jobs/trace-publication.worker.ts.
 */
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { verifyTraceHash, sha256Hex } from '../utils/hash.util';
import { Prisma } from '@prisma/client';
import { fetchIpfsBytes } from './ipfs.service';
import { getOnChainTrace, printable } from './chain.service';
import { registerHandler, type ChainTransactionRow, type CompletionOutcome } from './stellar/outbox';
import { processPublication } from '../jobs/trace-publication.worker';
import type { TraceAction } from '../lib/trace-actions';
import { fetchVerifiedBytes, pinJson } from './ipfs.service';
import { publishTrace } from './chain.service';
import type { AgentScope } from './agent-controls.service';
import { agentSigner } from './stellar/clients';
import type { TraceVerification } from '../types';

/**
 * Completion handler for `trace.publish` outbox rows (#35): links the landed
 * trace id even when the publication worker died between submitting and its
 * own confirm step. Idempotent: guarded on onChainTraceId still being null,
 * exactly like the indexer's TracePublished projection. Failures are left to
 * the publication worker's own retry state machine.
 */
export async function handleTracePublishOutcome(row: ChainTransactionRow, outcome: CompletionOutcome): Promise<void> {
  const traceId = row.refId;
  if (!traceId || outcome.status !== 'SUCCESS') return;
  const onChainTraceId = BigInt(String(outcome.value ?? '0'));
  await prisma.reasoningTrace.updateMany({
    where: { id: traceId, onChainTraceId: null },
    data: {
      onChainTraceId,
      publishTxHash: outcome.txHash ?? null,
      publishInnerTxHash: row.hash ?? outcome.txHash ?? null,
      verified: true,
    },
  });
  await prisma.tracePublication.updateMany({
    where: { traceId, status: { in: ['AWAITING_MARKET', 'READY', 'SUBMITTED'] } },
    data: { status: 'CONFIRMED', confirmedAt: new Date(), lastError: null },
  });
}

registerHandler('trace.publish', handleTracePublishOutcome);

/**
 * Records that a trace must be published (#131). The row is durable: if
 * pinning, the market's on-chain creation, or the publish call isn't possible
 * yet, src/jobs/trace-publication.worker.ts finishes it later. An immediate
 * best-effort pass runs in the background so the common case stays fast.
 */
export async function enqueueTracePublication(
  params: { traceId: string; payload: Record<string, unknown>; action: TraceAction },
  deps: { prisma?: any; processNow?: boolean } = {},
): Promise<{ id: string }> {
  const db = deps.prisma ?? prisma;
  const row = await db.tracePublication.upsert({
    where: { traceId: params.traceId },
    create: {
      traceId: params.traceId,
      action: params.action,
      payload: printable(params.payload) as Prisma.InputJsonValue,
    },
    update: {},
  });
  if (deps.processNow ?? true) {
    void processPublication(row, { prisma: db }).catch((err) =>
      logger.warn({ err, traceId: params.traceId }, 'Immediate trace publication pass failed; the worker will retry'),
    );
  }
  return { id: row.id };
}

/**
 * Fetches the content at the on-chain CID, hashes the exact bytes and
 * compares them with the on-chain trace_hash (x402/trace-verification.ts).
 */
export async function verifyTraceOnChain(traceId: string): Promise<TraceVerification> {
  const trace = await prisma.reasoningTrace.findUnique({
    where: { id: traceId },
    select: { id: true, onChainTraceId: true, traceHash: true },
  });
  if (!trace) throw new AppError(404, 'TRACE_NOT_FOUND', 'Reasoning trace not found');
  if (trace.onChainTraceId === null) {
    throw new AppError(409, 'TRACE_NOT_PUBLISHED', 'This trace has not been published on-chain yet');
  }

  const onChain = await getOnChainTrace(trace.onChainTraceId);
  const onChainHash = Buffer.from(onChain.trace_hash).toString('hex');
  const { bytes, source } = await fetchVerifiedBytes(
    onChain.ipfs_cid,
    onChainHash,
    `reasoning_registry:trace:${trace.onChainTraceId}`,
  );
  const verified = verifyTraceHash(bytes, onChainHash);

  await prisma.reasoningTrace.update({
    where: { id: traceId },
    data: {
      verified,
      lastAuditStatus: verified ? 'VERIFIED' : 'HASH_MISMATCH',
      lastAuditedAt: new Date(),
    },
  });

  return {
    traceId,
    onChainTraceId: trace.onChainTraceId.toString(),
    ipfsCid: onChain.ipfs_cid,
    onChainHash,
    computedHash: sha256Hex(bytes),
    storedHash: trace.traceHash,
    verified,
    contentSource: source,
    verifiedAt: new Date(),
  };
}

/**
 * Generalises pin+publish for documents that do not have a ReasoningTrace row
 * (transparency reports, #159). Returns the mode so callers can mark dry runs.
 */
export async function pinAndPublishDocument(params: {
  document: unknown;
  name: string;
  action: string;
  marketId: bigint;
  /** Agent whose control state gates the write; defaults from `action`. */
  scope?: AgentScope;
}, options: { dryRun?: boolean } = {}): Promise<{ cid: string; hash: string; onChainTraceId: bigint | null; publishTxHash: string | null; mode: 'dry-run' | 'live' }> {
  const pinned = await pinJson(params.document, params.name);
  if (options.dryRun) {
    return { cid: pinned.cid, hash: pinned.hash, onChainTraceId: null, publishTxHash: null, mode: 'dry-run' };
  }
  const published = await publishPinnedDocument({
    cid: pinned.cid,
    hash: pinned.hash,
    action: params.action,
    marketId: params.marketId,
    scope: params.scope,
  });
  return { cid: pinned.cid, hash: pinned.hash, ...published };
}

/**
 * Publishes bytes that are already pinned. Used to recover from a crash
 * between pin and publish without recomputing (and re-pinning) the document.
 */
export async function publishPinnedDocument(params: {
  cid: string;
  hash: string;
  action: string;
  marketId: bigint;
  scope?: AgentScope;
}, options: { dryRun?: boolean } = {}): Promise<{ onChainTraceId: bigint | null; publishTxHash: string | null; mode: 'dry-run' | 'live' }> {
  if (options.dryRun) {
    return { onChainTraceId: null, publishTxHash: null, mode: 'dry-run' };
  }
  const result = await publishTrace({
    agent: agentSigner().publicKey as string,
    market_id: params.marketId,
    action: params.action,
    trace_hash: Buffer.from(params.hash, 'hex'),
    ipfs_cid: params.cid,
  }, undefined, params.scope);
  if (result.mode === 'dry-run') {
    return { onChainTraceId: null, publishTxHash: null, mode: 'dry-run' };
  }
  return { onChainTraceId: result.value, publishTxHash: result.txHash, mode: 'live' };
}
