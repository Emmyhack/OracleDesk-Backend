import type { Request, Response } from 'express';
import { sendSuccess, parsePagination, buildPaginationMeta } from '../utils/response.util';
import { createOperationSchema, recordSchema, signatureSchema } from '../validators/admin.validator';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import { TraceAuditStatus } from '@prisma/client';
import { runTraceAudit } from '../services/trace-audit.service';
import { sendError } from '../utils/response.util';
import { logger } from '../lib/logger';
import { config } from '../config';
import { secret } from '../config/secrets';
import { health } from '../services/health.service';
import { indexerStatus } from '../services/indexer.service';
import { agentSigner } from '../services/stellar/clients';
import { getLlmUsage } from '../lib/llm-budget';
import { getCronStatus } from '../cron/registry';
import { AppError } from '../middlewares/error.middleware';
import {
  addSignature,
  cancelOperation,
  getOperation,
  getTreasuryState,
  listOperations,
  prepareOperation,
  recordSubmitted,
  submitOperation,
} from '../services/treasury-ops.service';

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return req.user.walletAddress;
}

export async function getTreasury(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await getTreasuryState());
}

export async function createOperation(req: Request, res: Response): Promise<void> {
  const parsed = createOperationSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid operation', parsed.error.flatten().fieldErrors as any);
  }
  const prepared = await prepareOperation(parsed.data.operation, actor(req));
  sendSuccess(res, prepared, 201);
}

export async function listTreasuryOperations(req: Request, res: Response): Promise<void> {
  const { page, limit } = parsePagination(req.query as any);
  const { rows, total } = await listOperations(page, limit);
  sendSuccess(res, rows, 200, buildPaginationMeta(page, limit, total) as any);
}

export async function getTreasuryOperation(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await getOperation(String(req.params.id)));
}

export async function addOperationSignature(req: Request, res: Response): Promise<void> {
  const parsed = signatureSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'signedXdr is required', parsed.error.flatten().fieldErrors as any);
  }
  sendSuccess(res, await addSignature(String(req.params.id), parsed.data.signedXdr, actor(req)));
}

export async function submitTreasuryOperation(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await submitOperation(String(req.params.id)));
}

export async function recordTreasuryOperation(req: Request, res: Response): Promise<void> {
  const parsed = recordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'txHash is required', parsed.error.flatten().fieldErrors as any);
  }
  await recordSubmitted(String(req.params.id), parsed.data.txHash, actor(req));
  sendSuccess(res, { recorded: true });
}

export async function cancelTreasuryOperation(req: Request, res: Response): Promise<void> {
  await cancelOperation(String(req.params.id), actor(req));
  sendSuccess(res, { cancelled: true });
}

/**
 * GET /admin/trace-audit
 * Returns summary counts by status, the latest audit run details,
 * and paginated non-verified findings (with optional status filtering).
 */
export async function getTraceAuditSummary(req: Request, res: Response): Promise<void> {
  const { page, limit, skip } = parsePagination(req.query as any);
  const statusParam = req.query.status as string | undefined;

  let validStatus: TraceAuditStatus | undefined;
  if (statusParam) {
    if (Object.values(TraceAuditStatus).includes(statusParam as TraceAuditStatus)) {
      validStatus = statusParam as TraceAuditStatus;
    } else {
      sendError(res, 400, 'INVALID_STATUS', `Status must be one of: ${Object.values(TraceAuditStatus).join(', ')}`);
      return;
    }
  }

  const [countsGroup, latestRun, findings, totalFindings] = await Promise.all([
    prisma.traceAudit.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
    prisma.traceAuditRun.findFirst({
      orderBy: { startedAt: 'desc' },
    }),
    prisma.traceAudit.findMany({
      where: validStatus
        ? { status: validStatus }
        : { status: { not: TraceAuditStatus.VERIFIED } },
      skip,
      take: limit,
      orderBy: { checkedAt: 'desc' },
    }),
    prisma.traceAudit.count({
      where: validStatus
        ? { status: validStatus }
        : { status: { not: TraceAuditStatus.VERIFIED } },
    }),
  ]);

  const counts: Record<string, number> = {};
  for (const status of Object.values(TraceAuditStatus)) {
    counts[status] = 0;
  }
  for (const g of countsGroup) {
    counts[g.status] = g._count.status;
  }

  sendSuccess(
    res,
    {
      counts,
      latestRun,
      findings,
    },
    200,
    buildPaginationMeta(page, limit, totalFindings) as any,
  );
}

/**
 * POST /admin/trace-audit/run
 * Starts a trace audit run asynchronously in the background.
 * Returns 202 with the runId.
 */
export async function triggerTraceAuditRun(req: Request, res: Response): Promise<void> {
  const runId = uuidv4();

  // Fire and forget
  runTraceAudit({ runId }).catch((err) => {
    logger.error({ err, runId }, 'Background trace audit run failed');
  });

  sendSuccess(res, { runId, message: 'Trace audit run scheduled' }, 202);
}

/**
 * GET /admin/status (#111)
 * Probe details, indexer lag, cron runs, chain mode and LLM state. Unlike
 * /readyz this includes ledger numbers, so it is admin-only.
 */
export async function getSystemStatus(_req: Request, res: Response): Promise<void> {
  const { ready, checks } = await health.readiness();
  const latestLedger = checks.find((c) => c.name === 'rpc')?.detail?.latestLedger;
  const indexer = indexerStatus();
  sendSuccess(res, {
    ready,
    draining: health.isDraining(),
    checks,
    indexer: {
      ...indexer,
      rpcLatestLedger: typeof latestLedger === 'number' ? latestLedger : null,
      lagLedgers: typeof latestLedger === 'number' && indexer.lastLedger !== null ? latestLedger - indexer.lastLedger : null,
    },
    crons: getCronStatus(),
    chain: {
      mode: config.CHAIN_EXECUTION_MODE,
      agentPublicKey: agentSigner().publicKey ?? null,
      preflight: 'not_implemented',
    },
    llm: {
      anthropicConfigured: secret('ANTHROPIC_API_KEY') !== '',
      geminiConfigured: secret('GEMINI_API_KEY') !== '',
      // Shared across instances (Redis); null when the guard store is down.
      usage: await getLlmUsage().catch(() => null),
    },
    process: {
      uptimeSeconds: process.uptime(),
      memory: process.memoryUsage(),
      version: process.env.npm_package_version ?? null,
    },
  });
}
