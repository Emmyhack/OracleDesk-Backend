import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendSuccess, parsePagination, buildPaginationMeta } from '../utils/response.util';
import {
  controlScopeSchema,
  createOperationSchema,
  pauseAgentSchema,
  reconcileRunSchema,
  recordSchema,
  resumeAgentSchema,
  signatureSchema,
} from '../validators/admin.validator';
import { controlsOverview, pauseAgent, resumeAgent } from '../services/agent-controls.service';
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
import { effectiveMode, specCompatReport } from '../services/stellar/spec-compat';
import { getFeeOracle } from '../services/stellar/fees';
import { getLlmUsage } from '../lib/llm-budget';
import { getCronStatus } from '../cron/registry';
import { AppError } from '../middlewares/error.middleware';
import {
  ADMIN_ROLES,
  grantAdminRole,
  isAdminAddress,
  isAdminRole,
  listAdminAudit,
  listAdmins,
  listRoles,
  revokeAdminRole,
} from '../services/admin-rbac.service';
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

/** GET /admin/agents/controls: effective state per scope plus the last 20 audit events. */
export async function getAgentControls(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await controlsOverview());
}

function agentParam(req: Request) {
  const scope = controlScopeSchema.safeParse(String(req.params.agent));
  if (!scope.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'agent must be one of ALL, MARKET_MAKER, TRADER');
  }
  return scope.data;
}

/** POST /admin/agents/:agent/pause: indefinite unless `until` is given. */
export async function pauseAgentControl(req: Request, res: Response): Promise<void> {
  const scope = agentParam(req);
  const body = pauseAgentSchema.safeParse(req.body);
  if (!body.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pause request', body.error.flatten().fieldErrors as any);
  }
  const until = body.data.until ? new Date(body.data.until) : undefined;
  if (until && until.getTime() <= Date.now()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'until must be in the future');
  }
  await pauseAgent(scope, { reason: body.data.reason, source: 'operator', actor: actor(req), until });
  sendSuccess(res, await controlsOverview());
}

/** POST /admin/agents/:agent/resume: clears only the named row. */
export async function resumeAgentControl(req: Request, res: Response): Promise<void> {
  const scope = agentParam(req);
  const body = resumeAgentSchema.safeParse(req.body ?? {});
  if (!body.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid resume request', body.error.flatten().fieldErrors as any);
  }
  await resumeAgent(scope, { actor: actor(req), reason: body.data.reason });
  sendSuccess(res, await controlsOverview());
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
 * GET /admin/chain/spec-compat (#34)
 * The last contract spec compatibility report from the boot gate: per
 * contract, the deployed wasm hash against the pinned one and every spec
 * difference with its breaking/compatible classification. `report` is null
 * when the gate has not run (SPEC_COMPAT_ENFORCE=off).
 */
export async function getSpecCompat(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { mode: effectiveMode(), report: specCompatReport() });
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

/**
 * GET /admin/fees
 * Returns aggregate fee statistics per operation class per day, plus the current fee oracle snapshot (#39).
 */
export async function getChainFeesReport(req: Request, res: Response): Promise<void> {
  const oracle = getFeeOracle();
  const snapshot = oracle.getSnapshot();

  const rows = await prisma.$queryRaw<Array<{
    op_class: string;
    day: Date;
    count: number | bigint;
    total_charged: string | bigint;
    p50_charged: string | number;
    p95_charged: string | number;
  }>>`
    SELECT
      op_class,
      DATE_TRUNC('day', created_at) AS day,
      COUNT(*)::int AS count,
      COALESCE(SUM(fee_charged), 0)::text AS total_charged,
      COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY fee_charged), 0)::numeric::text AS p50_charged,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY fee_charged), 0)::numeric::text AS p95_charged
    FROM chain_fees
    WHERE fee_charged IS NOT NULL
    GROUP BY op_class, DATE_TRUNC('day', created_at)
    ORDER BY day DESC, op_class ASC
  `;

  const report = rows.map((r) => ({
    opClass: r.op_class,
    day: r.day,
    count: Number(r.count),
    totalCharged: r.total_charged.toString(),
    p50Charged: r.p50_charged.toString(),
    p95Charged: r.p95_charged.toString(),
  }));

  sendSuccess(res, {
    oracle: snapshot,
    report,
  });
}


/** GET /admin/admins — current role assignments. */
export async function getAdmins(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await listAdmins());
}

/** GET /admin/roles — the fixed catalogue and its permissions. */
export async function getAdminRoles(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await listRoles());
}

/** POST /admin/admins/grant — grant or change a role (step-up protected). */
export async function postGrantAdmin(req: Request, res: Response): Promise<void> {
  const { walletAddress, roleName } = (req.body ?? {}) as {
    walletAddress?: unknown;
    roleName?: unknown;
  };
  if (!isAdminAddress(walletAddress)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'walletAddress must be a Stellar G… address');
  }
  if (!isAdminRole(roleName)) {
    throw new AppError(400, 'VALIDATION_ERROR', `roleName must be one of: ${ADMIN_ROLES.join(', ')}`);
  }
  await grantAdminRole({ walletAddress, roleName, actor: actor(req) });
  sendSuccess(res, { walletAddress, roleName });
}

/** POST /admin/admins/revoke — remove every role from an address (step-up). */
export async function postRevokeAdmin(req: Request, res: Response): Promise<void> {
  const { walletAddress } = (req.body ?? {}) as { walletAddress?: unknown };
  if (!isAdminAddress(walletAddress)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'walletAddress must be a Stellar G… address');
  }
  await revokeAdminRole({ walletAddress, actor: actor(req) });
  sendSuccess(res, { revoked: true });
}

/** GET /admin/audit — append-only admin action trail. */
export async function getAdminAudit(req: Request, res: Response): Promise<void> {
  const { page, limit, skip } = parsePagination(req.query as any);
  const { rows, total } = await listAdminAudit(limit, skip);
  sendSuccess(res, rows, 200, buildPaginationMeta(page, limit, total) as any);
}

// ─── Dispute monitor (#92) ───────────────────────────────────────────────

const disputeIdSchema = z.object({ id: z.string().uuid('id must be a dispute review UUID') });
const disputeListSchema = z.object({ status: z.enum(['open', 'all']).default('open') });

function disputeId(req: Request): string {
  const parsed = disputeIdSchema.safeParse(req.params);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid dispute id', parsed.error.flatten().fieldErrors as any);
  return parsed.data.id;
}

/** GET /admin/disputes?status=open|all — reviews with the window left on the ledger clock. */
export async function getDisputes(req: Request, res: Response): Promise<void> {
  const parsed = disputeListSchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'status must be open or all', parsed.error.flatten().fieldErrors as any);
  const { page, limit } = parsePagination(req.query as any);
  const { items, total, ledgerTime } = await listDisputes({ status: parsed.data.status, page, limit });
  sendSuccess(res, items, 200, { ...(buildPaginationMeta(page, limit, total) as any), ledgerTime });
}

/** POST /admin/disputes/:id/ack */
export async function ackDispute(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await acknowledge(disputeId(req), actor(req)));
}

/** POST /admin/disputes/:id/cancel-tx — unsigned cancel_proposal for the guardian's wallet. */
export async function cancelDisputeTx(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await buildGuardianTx(disputeId(req), 'cancel_proposal'));
}

/** POST /admin/disputes/:id/void-tx — unsigned guardian_void_market. */
export async function voidDisputeTx(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await buildGuardianTx(disputeId(req), 'guardian_void_market'));
}
