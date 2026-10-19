import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendSuccess, sendError, parsePagination, buildPaginationMeta } from '../utils/response.util';
import { summarizeProvenance } from '../lib/llm/provenance';
import { verifyTraceOnChain } from '../services/trace-publish.service';
import {
  getTracWithAccessControl,
  getSpendingAllowance,
  listPaymentEvents,
  recordPayment,
  upsertSpendingAllowance,
} from '../services/subscription.service';

const unlockSchema = z.object({
  txHash:    z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex transaction hash'),
  type:      z.enum(['PER_TRACE', 'DAILY_PASS']),
  amountRaw: z.string().regex(/^\d+$/).optional(),
  amount:    z.number().positive().optional(),
});

/**
 * GET /traces
 * Returns paginated list of reasoning traces.
 * Preview data only (no full sources) unless authenticated with subscription.
 */
export async function listTraces(req: Request, res: Response): Promise<void> {
  const { page, limit, skip } = parsePagination(req.query as any);
  const agentType = req.query.agentType;
  const marketId = req.query.marketId;
  if (agentType !== undefined && agentType !== 'MARKET_MAKER' && agentType !== 'TRADER') {
    sendError(res, 400, 'VALIDATION_ERROR', 'agentType must be MARKET_MAKER or TRADER');
    return;
  }

  const where = {
    ...(agentType ? { agentType: agentType as 'MARKET_MAKER' | 'TRADER' } : {}),
    ...(typeof marketId === 'string' && marketId ? { marketId } : {}),
  };

  const [traces, total] = await Promise.all([
    prisma.reasoningTrace.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id:                  true,
        marketId:            true,
        agentType:           true,
        decisionType:        true,
        edge:                true,
        probabilityEstimate: true,
        marketProbability:   true,
        confidenceInterval:  true,
        verified:            true,
        ipfsCid:             true,
        traceHash:           true,
        onChainTraceId:      true,
        publishTxHash:       true,
        previewSources:      true,
        provenance:          true,
        lastAuditStatus:     true,
        lastAuditedAt:       true,
        createdAt:           true,
        market: { select: { question: true, category: true, settlementCurrency: true, onChainMarketId: true } },
      },
    }),
    prisma.reasoningTrace.count({ where }),
  ]);

  const formattedTraces = traces.map(({ provenance, ...t }) => ({
    ...t,
    provenance: { summary: summarizeProvenance(provenance) },
    audit: t.lastAuditStatus ? { status: t.lastAuditStatus, checkedAt: t.lastAuditedAt } : null,
  }));

  sendSuccess(res, formattedTraces, 200, buildPaginationMeta(page, limit, total) as any);
}

/**
 * GET /traces/:id
 * Returns full trace detail with access control.
 * - No auth: preview (first 2 sources only)
 * - Subscribed: full trace
 */
export async function getTrace(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const userId = req.user?.userId;

  const trace = await getTracWithAccessControl(id, userId);
  sendSuccess(res, trace);
}

/**
 * POST /traces/verify
 * Fetches the content at the on-chain CID and compares sha256 of the exact
 * bytes with reasoning_registry.get_trace(...).trace_hash.
 *
 * Request body: { traceId: string }
 */
export async function verifyTrace(req: Request, res: Response): Promise<void> {
  const { traceId } = req.body as { traceId?: string };

  if (!traceId) {
    sendError(res, 400, 'MISSING_TRACE_ID', 'traceId is required');
    return;
  }

  const verification = await verifyTraceOnChain(traceId);
  sendSuccess(res, verification);
}

/**
 * POST /traces/:id/unlock
 * Daily pass: verifies an on-chain USDC transfer and grants 24h access.
 *
 * Request body: { txHash, type: 'DAILY_PASS', amountRaw? }
 * The amount is taken from the verified transaction, not from the body.
 */
export async function unlockTrace(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }

  const parsed = unlockSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'VALIDATION_ERROR', 'txHash and type are required',
      parsed.error.flatten().fieldErrors as any);
    return;
  }

  const traceId = String(req.params.id);
  const subscription = await recordPayment({
    userId:        req.user.userId,
    walletAddress: req.user.walletAddress,
    traceId:       undefined,
    type:          parsed.data.type,
    txHash:        parsed.data.txHash,
    subId:         req.user.subId ?? null,
    subIdKind:     req.user.subIdKind ?? null,
  });

  const trace = await getTracWithAccessControl(traceId, req.user.userId).catch(() => null);
  sendSuccess(res, { subscription, trace }, 201);
}

export async function setSpendingAllowance(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }

  const { dailyLimit, perTraceLimit, currency } = req.body as {
    dailyLimit?: number;
    perTraceLimit?: number;
    currency?: string;
  };

  if (typeof dailyLimit !== 'number' || typeof perTraceLimit !== 'number') {
    sendError(res, 400, 'MISSING_ALLOWANCE_FIELDS', 'dailyLimit and perTraceLimit are required numbers');
    return;
  }

  // Ensure the user record exists before creating the FK-linked spending
  // allowance. Key on the user id: walletAddress is no longer unique (#46),
  // several sub-users share one pooled base account.
  const identityKey = req.user.subId != null
    ? `${req.user.walletAddress}#${req.user.subIdKind === 'MUXED' ? 'muxed' : 'memo'}:${req.user.subId}`
    : req.user.walletAddress;
  await prisma.user.upsert({
    where:  { id: req.user.userId },
    create: {
      id:            req.user.userId,
      walletAddress: req.user.walletAddress,
      subId:         req.user.subId ?? null,
      subIdKind:     req.user.subIdKind ?? null,
      identityKey,
    },
    update: {},
  });

  const allowance = await upsertSpendingAllowance({
    userId: req.user.userId,
    dailyLimit,
    perTraceLimit,
    currency,
  });

  sendSuccess(res, allowance, 200);
}

export async function getMySpendingAllowance(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }

  const allowance = await getSpendingAllowance(req.user.userId);
  sendSuccess(res, allowance);
}

export async function getMyPaymentEvents(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }

  const payments = await listPaymentEvents(req.user.userId);
  sendSuccess(res, payments);
}