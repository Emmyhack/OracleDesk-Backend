import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { writeAgentLog } from '../lib/agent-log';
import { bindDetached } from '../lib/context';
import { v4 as uuidv4 } from 'uuid';
import type { JobRecord } from '../types';
import { JobStatus } from '../types';
import { sendSuccess, sendError, parsePagination, buildPaginationMeta } from '../utils/response.util';
import { runMarketMakerCycle } from '../agents/market-maker.agent';
import { generateMarketSchema, listMarketsSchema } from '../validators/market.validator';
import { toContractCategory } from '../lib/categories';
import { parseU64 } from '../lib/amounts';
import { getOnChainMarket, printable } from '../services/chain.service';
import { marketStatusView } from '../services/oracle.service';
import { priceYesBps } from '../generated/fpmm';
import {
  MarketCategory,
  MarketStatus,
  SettlementCurrency,
  Prisma,
} from '@prisma/client';
import { AppError } from '../middlewares/error.middleware';


const jobTracker: Map<string, JobRecord> = new Map();

/** Adds the contract category. BigInts are stringified by the app's JSON replacer. */
function serializeMarket<T extends { category: MarketCategory }>(market: T) {
  return { ...market, contractCategory: toContractCategory(market.category) };
}

const marketDetailInclude = {
  reasoningTraces: {
    orderBy: { createdAt: 'desc' as const },
    take: 5,
    select: {
      id: true,
      agentType: true,
      edge: true,
      probabilityEstimate: true,
      verified: true,
      onChainTraceId: true,
      createdAt: true,
    },
  },
  _count: { select: { trades: true, positions: true, reasoningTraces: true } },
};

// Prune completed/failed jobs older than 1 hour to prevent unbounded Map growth
const JOB_RETENTION_MS = 60 * 60 * 1000;
function pruneJobTracker(): void {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobTracker) {
    if (job.completedAt && job.completedAt.getTime() < cutoff) {
      jobTracker.delete(id);
    }
  }
}

/**
 * GET /markets
 * Returns a paginated list of prediction markets.
 * Query params: status, category, currency, page, limit
 */
export async function listMarkets(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = listMarketsSchema.safeParse({
    query: req.query,
  });

  if (!parsed.success) {
    sendError(
      res,
      400,
      'VALIDATION_ERROR',
      'Invalid query parameters',
      parsed.error.flatten().fieldErrors as any,
    );

    return;
  }

  const {
    status,
    category,
    currency,
    onChain,
    page: p,
    limit: l,
  } = parsed.data.query;

  const { page, limit, skip } = parsePagination({
    page: p,
    limit: l,
  });

  const where: Prisma.MarketWhereInput = {
  ...(status
    ? { status: status as MarketStatus }
    : {}),

  ...(category
    ? { category: category as MarketCategory }
    : {}),

  ...(currency
    ? {
        settlementCurrency:
          currency as SettlementCurrency,
      }
    : {}),

  ...(onChain === 'true' ? { onChainMarketId: { not: null } } : {}),
  ...(onChain === 'false' ? { onChainMarketId: null } : {}),
};

  const [markets, total] = await Promise.all([
    prisma.market.findMany({
      where,
      skip,
      take: limit,
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        _count: {
          select: {
            trades: true,
            reasoningTraces: true,
          },
        },
      },
    }),

    prisma.market.count({ where }),
  ]);

  sendSuccess(
    res,
    markets.map(serializeMarket),
    200,
    buildPaginationMeta(page, limit, total) as any,
  );
}

/**
 * GET /markets/:id
 * Returns full detail for a single market including confidence interval
 * and linked reasoning traces.
 */
export async function getMarket(
  req: Request,
  res: Response,
): Promise<void> {
  const id = String(req.params.id);

  const market = await prisma.market.findUnique({ where: { id }, include: marketDetailInclude });

  if (!market) {
    sendError(
      res,
      404,
      'MARKET_NOT_FOUND',
      `Market ${id} not found`,
    );

    return;
  }

  sendSuccess(res, serializeMarket(market));
}

/**
 * GET /markets/on-chain/:onChainMarketId
 * Backend record for a market-core market id.
 */
export async function getMarketByOnChainId(req: Request, res: Response): Promise<void> {
  const raw = String(req.params.onChainMarketId);
  const onChainMarketId = parseU64(raw);
  if (onChainMarketId === null) {
    sendError(res, 400, 'INVALID_MARKET_ID', 'onChainMarketId must be a decimal u64');
    return;
  }
  const market = await prisma.market.findUnique({ where: { onChainMarketId }, include: marketDetailInclude });
  if (!market) {
    sendError(res, 404, 'MARKET_NOT_FOUND', `No backend market for on-chain id ${raw}`);
    return;
  }
  sendSuccess(res, serializeMarket(market));
}

/**
 * POST /markets/generate
 * Manually trigger one Market Maker Agent cycle.
 * Used for hackathon demos and testing.
 * Requires auth.
 */
export async function triggerMarketGeneration(
  req: Request,
  res: Response,
): Promise<void> {
  const body = generateMarketSchema.safeParse(req.body);
  if (!body.success) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid generation parameters', body.error.flatten().fieldErrors as any);
    return;
  }

  const jobId = uuidv4();

  // Prune old jobs to keep memory bounded
  pruneJobTracker();

  // ── Register RUNNING job ─────────────────────────────────────

  jobTracker.set(jobId, {
    status: JobStatus.RUNNING,
    startedAt: new Date(),
  });

  // ── Persist audit log ────────────────────────────────────────

  bindDetached(
    () =>
      writeAgentLog({
        agentType: 'MARKET_MAKER',
        level: 'INFO',
        action: 'GENERATION_JOB_STARTED',
        data: { jobId },
      }),
    { jobId },
  )
    .catch(() => {
      // Non-blocking
    });

  // ── Run generation in background ─────────────────────────────

  bindDetached(() => runMarketMakerCycle({ priority: 'admin' }), { jobId, kind: 'job' })
    .then((result: any) => {
      const existingJob = jobTracker.get(jobId);

      if (!existingJob) {
        return;
      }

      jobTracker.set(jobId, {
        status: JobStatus.COMPLETED,
        startedAt: existingJob.startedAt,
        completedAt: new Date(),

        marketId: result?.marketId,
        onChainMarketId: result?.onChainMarketId ?? null,
        question: result?.question,
        category: result?.category,
      });
    })
    .catch((err: Error) => {
      const existingJob = jobTracker.get(jobId);

      if (!existingJob) {
        return;
      }

      jobTracker.set(jobId, {
        status: JobStatus.FAILED,
        startedAt: existingJob.startedAt,
        completedAt: new Date(),
        error: err.message,
      });
    });

  sendSuccess(
    res,
    {
      jobId,

      message:
        'Market Maker cycle started. AI agent is analysing live signals.',

      statusUrl: `/api/v1/markets/generation-status/${jobId}`,

      hint:
        'Poll statusUrl every 5 seconds until status is COMPLETED or FAILED.',
    },
    202,
  );
}

/**
 * GET /api/v1/markets/generation-status/:jobId
 *
 * Poll background job status.
 */
export async function getMarketGenerationStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const { jobId } = req.params;

  if (!jobId || typeof jobId !== 'string') {
    sendError(
      res,
      400,
      'INVALID_JOB_ID',
      'jobId must be a non-empty string',
    );

    return;
  }

  // ── Check memory tracker ─────────────────────────────────────

  const job = jobTracker.get(jobId);

  if (job) {
    const elapsedMs = job.completedAt
      ? job.completedAt.getTime() - job.startedAt.getTime()
      : Date.now() - job.startedAt.getTime();

    sendSuccess(res, {
      jobId,

      status: job.status,

      startedAt: job.startedAt,

      completedAt: job.completedAt ?? null,

      elapsedMs,

      ...(job.marketId
        ? {
            marketId: job.marketId,
            onChainMarketId: job.onChainMarketId ?? null,
            question: job.question,
            category: job.category,
            marketUrl: `/api/v1/markets/${job.marketId}`,
          }
        : {}),

      ...(job.error
        ? {
            error: job.error,
          }
        : {}),
    });

    return;
  }

  // ── Check persisted DB logs ──────────────────────────────────

  const dbLog = await prisma.agentLog.findFirst({
    where: {
      action: 'GENERATION_JOB_STARTED',

      data: {
        path: ['jobId'],
        equals: jobId,
      },
    },

    orderBy: {
      createdAt: 'desc',
    },
  });

  if (!dbLog) {
    sendError(
      res,
      404,
      'JOB_NOT_FOUND',
      `No generation job found with id: ${jobId}`,
    );

    return;
  }

  // ── Job existed before restart ───────────────────────────────

  sendSuccess(res, {
    jobId,

    status: JobStatus.UNKNOWN,

    startedAt: dbLog.createdAt,

    message:
      'Server restarted after this job started. Check recent markets.',

    hint:
      'Filter GET /api/v1/markets by recent createdAt timestamps.',
  });
}

/**
 * GET /markets/on-chain/:onChainMarketId/state
 * market_core.get_market read live from the network, plus yesBps computed
 * with the contract's own FPMM math. No database involved.
 */
export async function getOnChainMarketState(req: Request, res: Response): Promise<void> {
  const raw = String(req.params.onChainMarketId);
  const onChainMarketId = parseU64(raw);
  if (onChainMarketId === null) {
    sendError(res, 400, 'INVALID_MARKET_ID', 'onChainMarketId must be a decimal u64');
    return;
  }
  const market = await getOnChainMarket(onChainMarketId, req.signal);
  sendSuccess(res, {
    onChainMarketId: raw,
    ...(printable({ ...market, status: undefined, category: market.category.tag }) as object),
    status: marketStatusView(market.status),
    yesBps: Number(priceYesBps(market.reserve_yes, market.reserve_no)),
    source: 'chain',
  });
}
