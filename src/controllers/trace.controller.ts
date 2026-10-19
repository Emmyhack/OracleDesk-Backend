import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendSuccess, sendError, parsePagination, buildPaginationMeta } from '../utils/response.util';
import { summarizeProvenance } from '../lib/llm/provenance';
import { verifyTraceOnChain } from '../services/trace-publish.service';
import {
  DAILY_PASS_PRICE_RAW,
  getTracWithAccessControl,
  getSpendingAllowance,
  listPaymentEvents,
  preauthorizeSpending,
  recordPayment,
  upsertSpendingAllowance,
} from '../services/subscription.service';
import {
  createPaymentIntent,
  getPaymentIntent,
  submitPaymentIntent,
} from '../services/payment-intent.service';

const preauthorizeSchema = z.object({
  type: z.enum(['PER_TRACE', 'DAILY_PASS']).default('DAILY_PASS'),
  amountRaw: z.string().regex(/^\d+$/, 'must be an integer in 7-decimal base units').optional(),
});

const intentSubmitSchema = z.object({
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex transaction hash'),
});

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

  const { dailyLimit, perTraceLimit, dailyLimitRaw, perTraceLimitRaw, currency } = req.body as {
    dailyLimit?: number;
    perTraceLimit?: number;
    dailyLimitRaw?: string;
    perTraceLimitRaw?: string;
    currency?: string;
  };

  if (typeof dailyLimit !== 'number' || typeof perTraceLimit !== 'number') {
    sendError(res, 400, 'MISSING_ALLOWANCE_FIELDS', 'dailyLimit and perTraceLimit are required numbers');
    return;
  }
  if (
    (dailyLimitRaw !== undefined && !/^\d+$/.test(dailyLimitRaw)) ||
    (perTraceLimitRaw !== undefined && !/^\d+$/.test(perTraceLimitRaw))
  ) {
    sendError(res, 400, 'VALIDATION_ERROR', 'dailyLimitRaw and perTraceLimitRaw must be integer base-unit strings');
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
    dailyLimitRaw,
    perTraceLimitRaw,
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
/**
 * POST /traces/access/preauthorize
 * Advisory-only check against the user's exact spending approval (#53). It
 * never reserves budget or writes; the payment can still be accepted with an
 * overage flag, but the client should warn before asking the wallet to sign.
 */
export async function preauthorizeAccess(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }
  const parsed = preauthorizeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid preauthorization request', parsed.error.flatten().fieldErrors as any);
    return;
  }
  const amountRaw = parsed.data.amountRaw
    ? BigInt(parsed.data.amountRaw)
    : parsed.data.type === 'DAILY_PASS'
      ? DAILY_PASS_PRICE_RAW
      : null;
  if (amountRaw == null || amountRaw <= 0n) {
    sendError(res, 400, 'VALIDATION_ERROR', 'amountRaw is required for PER_TRACE preauthorization');
    return;
  }
  const decision = await preauthorizeSpending(req.user.userId, parsed.data.type, amountRaw);
  sendSuccess(res, { type: parsed.data.type, amountRaw: amountRaw.toString(), ...decision });
}

/** POST /traces/payment-intents — issue a server-priced daily-pass intent (#52). */
export async function createIntent(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }
  const created = await createPaymentIntent(req.user.userId, req.user.walletAddress);
  sendSuccess(res, created, 201);
}

/** GET /traces/payment-intents/:id — the caller's own intent. */
export async function getIntent(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }
  sendSuccess(res, await getPaymentIntent(req.user.userId, String(req.params.id)));
}

/**
 * POST /traces/payment-intents/:id/submit — attach a tx hash and settle or
 * move the intent to PENDING_PAYMENT. Safe to call again.
 */
export async function submitIntent(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }
  const parsed = intentSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'VALIDATION_ERROR', 'txHash is required', parsed.error.flatten().fieldErrors as any);
    return;
  }
  const result = await submitPaymentIntent({
    userId: req.user.userId,
    walletAddress: req.user.walletAddress,
    id: String(req.params.id),
    txHash: parsed.data.txHash,
  });
  sendSuccess(res, result, result.status === 'CONFIRMED' ? 201 : 202);
}
