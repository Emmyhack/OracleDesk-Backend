import type { Request, Response } from 'express';
import { sendSuccess, parsePagination, buildPaginationMeta } from '../utils/response.util';
import { createOperationSchema, recordSchema, reconcileRunSchema, signatureSchema } from '../validators/admin.validator';
import { defaultDeps, runReconciliation } from '../services/market-reconciler.service';
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
  acknowledge,
  buildGuardianTx,
  listDisputes,
} from '../services/dispute-monitor.service';
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

/** GET /admin/reconciliation/runs?limit= — newest first. */
export async function listReconciliationRuns(req: Request, res: Response): Promise<void> {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
  sendSuccess(res, await prisma.reconcileRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit }));
}

/** GET /admin/reconciliation/runs/:id — the run and its findings, paginated. */
export async function getReconciliationRun(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const run = await prisma.reconcileRun.findUnique({ where: { id } });
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'Reconciliation run not found');
  const { page, limit, skip } = parsePagination(req.query as any);
  const [findings, total] = await Promise.all([
    prisma.marketDriftReport.findMany({ where: { runId: id }, orderBy: { createdAt: 'asc' }, skip, take: limit }),
    prisma.marketDriftReport.count({ where: { runId: id } }),
  ]);
  sendSuccess(res, { run, findings }, 200, buildPaginationMeta(page, limit, total) as any);
}

/**
 * POST /admin/reconciliation/run
 * Starts a run in the background (same advisory lock as the cron) and returns
 * 202 with its id.
 */
export async function triggerReconciliationRun(req: Request, res: Response): Promise<void> {
  const parsed = reconcileRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid reconciliation request', parsed.error.flatten().fieldErrors as any);
  }
  const runId = uuidv4();
  const io = req.app.get('io') as { to(room: string): { emit(e: string, p: unknown): void } } | undefined;
  runReconciliation(
    { runId, dryRun: parsed.data.dryRun ?? false, ...(parsed.data.maxMarkets ? { maxMarkets: parsed.data.maxMarkets } : {}) },
    { ...defaultDeps, emit: io ? (e, p) => io.to('admins').emit(e, p) : undefined },
  ).catch((err) => logger.error({ err, runId }, 'Background reconciliation run failed'));
  sendSuccess(res, { runId, message: 'Reconciliation run scheduled' }, 202);
}
