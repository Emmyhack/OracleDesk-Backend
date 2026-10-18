import { TraceAuditStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { prisma as defaultPrisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { CONTRACTS } from '../config/contracts';
import { agentSigner } from './stellar/clients';
import { sha256Hex } from '../utils/hash.util';
import { fetchIpfsBytes } from './ipfs.service';
import {
  traceCount,
  marketTraceCount,
  marketTraceAt,
  getOnChainTraceOrNull,
  ArchivedEntryError,
} from './chain.service';

export { TraceAuditStatus };

export interface RegistryReader {
  traceCount(): Promise<bigint>;
  marketTraceCount(marketId: bigint): Promise<bigint>;
  marketTraceAt(marketId: bigint, index: bigint): Promise<bigint>;
  getOnChainTraceOrNull(traceId: bigint): Promise<any | null>;
}

export const defaultRegistryReader: RegistryReader = {
  traceCount,
  marketTraceCount,
  marketTraceAt,
  getOnChainTraceOrNull,
};

export interface ClassifyInput {
  onChain: {
    market_id: bigint;
    agent: string;
    action: string;
    trace_hash: Buffer | string;
    ipfs_cid: string;
    published_at?: bigint;
  } | null;
  db: {
    id: string;
    marketId: string;
    onChainTraceId: bigint | null;
    traceHash: string;
    ipfsCid: string;
    market?: { onChainMarketId: bigint | null } | null;
  } | null;
  dbMarket?: { id: string; onChainMarketId: bigint | null } | null;
  fetched: { bytes: Buffer } | { error: string } | null;
  knownAgents: Set<string>;
  isArchived?: boolean;
}

export interface ClassifyResult {
  status: TraceAuditStatus;
  detail?: Record<string, unknown>;
  computedHash?: string;
  onChainHash?: string;
}

/**
 * Pure classification function.
 * Evaluates an on-chain record against DB state, fetched content, and known agents.
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const { onChain, db, dbMarket, fetched, knownAgents, isArchived } = input;

  if (!onChain) {
    if (isArchived) {
      return { status: TraceAuditStatus.ARCHIVED, detail: { reason: 'Entry archived on-chain' } };
    }
    return { status: TraceAuditStatus.NOT_ON_CHAIN, detail: { reason: 'TraceNotFound on-chain' } };
  }

  const onChainHash = Buffer.isBuffer(onChain.trace_hash)
    ? onChain.trace_hash.toString('hex').toLowerCase()
    : String(onChain.trace_hash).toLowerCase();

  const agentUpper = onChain.agent.toUpperCase();
  const isKnownAgent = Array.from(knownAgents).some((k) => k.toUpperCase() === agentUpper);

  if (!db) {
    if (!isKnownAgent) {
      return {
        status: TraceAuditStatus.FOREIGN_AGENT,
        onChainHash,
        detail: { agent: onChain.agent, marketId: onChain.market_id.toString() },
      };
    }
    return {
      status: TraceAuditStatus.UNKNOWN_TO_BACKEND,
      onChainHash,
      detail: { agent: onChain.agent, marketId: onChain.market_id.toString() },
    };
  }

  // Verify market assignment
  const dbMarketOnChainId = db.market?.onChainMarketId ?? dbMarket?.onChainMarketId;
  if (dbMarketOnChainId !== undefined && dbMarketOnChainId !== null && dbMarketOnChainId !== onChain.market_id) {
    return {
      status: TraceAuditStatus.WRONG_MARKET,
      onChainHash,
      detail: {
        expectedMarketId: onChain.market_id.toString(),
        actualMarketId: dbMarketOnChainId.toString(),
      },
    };
  }

  // Check fetched content
  let computedHash: string | undefined;
  if (fetched) {
    if ('error' in fetched) {
      return {
        status: TraceAuditStatus.UNAVAILABLE,
        onChainHash,
        detail: { error: fetched.error },
      };
    }
    computedHash = sha256Hex(fetched.bytes).toLowerCase();
    if (computedHash !== onChainHash) {
      return {
        status: TraceAuditStatus.HASH_MISMATCH,
        onChainHash,
        computedHash,
        detail: { onChainHash, computedHash, ipfsCid: onChain.ipfs_cid },
      };
    }
  }

  // Unlinked in DB: matched by hash or market, but onChainTraceId is null
  if (db.onChainTraceId === null) {
    return {
      status: TraceAuditStatus.UNLINKED_IN_DB,
      onChainHash,
      computedHash,
      detail: { traceId: db.id, storedHash: db.traceHash },
    };
  }

  // Hash disagreements between DB and on-chain (even if verified against fetched bytes)
  const detail: Record<string, unknown> = {};
  if (db.traceHash.toLowerCase() !== onChainHash) {
    detail.dbHashMismatch = { dbHash: db.traceHash, onChainHash };
  }
  if (db.ipfsCid !== onChain.ipfs_cid) {
    detail.cidMismatch = { dbCid: db.ipfsCid, onChainCid: onChain.ipfs_cid };
  }

  return {
    status: TraceAuditStatus.VERIFIED,
    onChainHash,
    computedHash,
    detail: Object.keys(detail).length > 0 ? detail : undefined,
  };
}

export interface TraceAuditOptions {
  runId?: string;
  reader?: RegistryReader;
  prisma?: any;
  maxRpc?: number;
  maxFetches?: number;
  maxBytes?: number;
  recheckHours?: number;
  fetchBytesFn?: (cid: string, opts?: { maxBytes?: number }) => Promise<Buffer>;
}

export interface TraceAuditSummary {
  runId: string;
  totalAudited: number;
  counts: Record<string, number>;
  relinked: number;
  rpcCalls: number;
  fetches: number;
}

export async function runTraceAudit(opts: TraceAuditOptions = {}): Promise<TraceAuditSummary> {
  const prisma = opts.prisma ?? defaultPrisma;
  const reader = opts.reader ?? defaultRegistryReader;
  const maxRpc = opts.maxRpc ?? config.TRACE_AUDIT_MAX_RPC;
  const maxFetches = opts.maxFetches ?? config.TRACE_AUDIT_MAX_FETCHES;
  const maxBytes = opts.maxBytes ?? config.TRACE_AUDIT_MAX_BYTES;
  const recheckHours = opts.recheckHours ?? config.TRACE_AUDIT_RECHECK_HOURS;
  const fetchFn = opts.fetchBytesFn ?? ((cid) => fetchIpfsBytes(cid));

  let rpcCalls = 0;
  let fetches = 0;
  let relinked = 0;

  const runId = opts.runId ?? uuidv4();
  const runRecord = await prisma.traceAuditRun.create({
    data: { id: runId, startedAt: new Date() },
  });

  const knownAgents = new Set<string>();
  const deployedAgent = (CONTRACTS as Record<string, string | undefined>).deployedAgent;
  if (deployedAgent) knownAgents.add(deployedAgent.toUpperCase());
  try {
    const signer = agentSigner();
    if (signer?.publicKey) knownAgents.add(signer.publicKey.toUpperCase());
  } catch {
    // In test/dry-run without configured key, ignore
  }

  const counts: Record<string, number> = {
    VERIFIED: 0,
    HASH_MISMATCH: 0,
    UNAVAILABLE: 0,
    UNKNOWN_TO_BACKEND: 0,
    WRONG_MARKET: 0,
    UNLINKED_IN_DB: 0,
    NOT_ON_CHAIN: 0,
    FOREIGN_AGENT: 0,
    ARCHIVED: 0,
  };

  // Collect trace IDs to inspect
  const candidateIds = new Set<bigint>();

  // A. Per-market pass: audit known markets with onChainMarketId
  const markets = await prisma.market.findMany({
    where: { onChainMarketId: { not: null } },
    select: { id: true, onChainMarketId: true },
  });

  for (const m of markets) {
    if (rpcCalls >= maxRpc) break;
    if (m.onChainMarketId === null) continue;
    try {
      const count = await reader.marketTraceCount(m.onChainMarketId);
      rpcCalls++;
      for (let i = 0n; i < count; i++) {
        if (rpcCalls >= maxRpc) break;
        const tid = await reader.marketTraceAt(m.onChainMarketId, i);
        rpcCalls++;
        candidateIds.add(tid);
      }
    } catch (err) {
      logger.warn({ marketId: m.id, err }, 'Failed reading market traces from registry');
    }
  }

  // B. Global pass: walk from last cursor up to traceCount() - 1
  let nextCursor: bigint | null = null;
  if (rpcCalls < maxRpc) {
    try {
      const totalCount = await reader.traceCount();
      rpcCalls++;
      const lastRun = await prisma.traceAuditRun.findFirst({
        where: { finishedAt: { not: null }, cursorTraceId: { not: null } },
        orderBy: { startedAt: 'desc' },
      });
      const startCursor = lastRun?.cursorTraceId ?? 0n;
      let cur = startCursor;
      while (cur < totalCount && rpcCalls < maxRpc) {
        candidateIds.add(cur);
        cur++;
      }
      nextCursor = cur;
    } catch (err) {
      logger.warn({ err }, 'Failed reading global trace count from registry');
    }
  }

  // C. Re-audit pass: non-VERIFIED or stale records
  const staleThreshold = new Date(Date.now() - recheckHours * 3600 * 1000);
  const staleAudits = await prisma.traceAudit.findMany({
    where: {
      OR: [
        { status: { not: TraceAuditStatus.VERIFIED } },
        { checkedAt: { lt: staleThreshold } },
      ],
      onChainTraceId: { not: null },
    },
    take: 50,
    select: { onChainTraceId: true },
  });
  for (const a of staleAudits) {
    if (a.onChainTraceId !== null) candidateIds.add(a.onChainTraceId);
  }

  // D. DB pass: DB traces with onChainTraceId not in candidate list
  const dbTracesWithOnChain = await prisma.reasoningTrace.findMany({
    where: { onChainTraceId: { not: null } },
    select: { onChainTraceId: true },
    take: 50,
  });
  for (const t of dbTracesWithOnChain) {
    if (t.onChainTraceId !== null) candidateIds.add(t.onChainTraceId);
  }

  let totalAudited = 0;

  for (const onChainTraceId of candidateIds) {
    if (rpcCalls >= maxRpc) break;

    let onChain: any = null;
    let isArchived = false;

    try {
      onChain = await reader.getOnChainTraceOrNull(onChainTraceId);
      rpcCalls++;
    } catch (err: any) {
      if (err instanceof ArchivedEntryError || err?.code === 'ARCHIVED_ENTRY') {
        isArchived = true;
      } else {
        logger.warn({ onChainTraceId: onChainTraceId.toString(), err }, 'Error reading on-chain trace');
      }
    }

    // Lookup matching DB trace
    let dbTrace = await prisma.reasoningTrace.findUnique({
      where: { onChainTraceId },
      include: { market: { select: { onChainMarketId: true } } },
    });

    if (!dbTrace && onChain) {
      const hexHash = Buffer.isBuffer(onChain.trace_hash)
        ? onChain.trace_hash.toString('hex').toLowerCase()
        : String(onChain.trace_hash).toLowerCase();

      // Find by hash, prioritizing matching market
      const matchingTraces = await prisma.reasoningTrace.findMany({
        where: { traceHash: hexHash },
        include: { market: { select: { onChainMarketId: true } } },
      });
      dbTrace =
        matchingTraces.find((t: any) => t.market?.onChainMarketId === onChain.market_id) ||
        matchingTraces[0] ||
        null;
    }

    let dbMarket: any = null;
    if (onChain) {
      dbMarket = await prisma.market.findFirst({
        where: { onChainMarketId: onChain.market_id },
        select: { id: true, onChainMarketId: true },
      });
    }

    // Content fetch if available and budget permits
    let fetched: { bytes: Buffer } | { error: string } | null = null;
    if (onChain?.ipfs_cid) {
      if (fetches < maxFetches) {
        try {
          const bytes = await fetchFn(onChain.ipfs_cid, { maxBytes });
          fetches++;
          fetched = { bytes };
        } catch (err: any) {
          fetches++;
          fetched = { error: err.message || String(err) };
        }
      } else {
        fetched = { error: 'Fetch budget exceeded' };
      }
    }

    const classified = classify({
      onChain,
      db: dbTrace,
      dbMarket,
      fetched,
      knownAgents,
      isArchived,
    });

    counts[classified.status] = (counts[classified.status] || 0) + 1;
    totalAudited++;

    // Safe relink for UNLINKED_IN_DB
    if (
      classified.status === TraceAuditStatus.UNLINKED_IN_DB &&
      dbTrace &&
      dbTrace.onChainTraceId === null &&
      onChain
    ) {
      // Find publish txHash if available from chain_events
      let publishTxHash: string | null = null;
      try {
        const ev = await prisma.chainEvent.findFirst({
          where: {
            eventName: 'TracePublished',
            params: { path: ['trace_id'], equals: onChainTraceId.toString() },
          },
          select: { txHash: true },
        });
        if (ev?.txHash) publishTxHash = ev.txHash;
      } catch {
        // ignore JSON path error if unsupported
      }

      await prisma.reasoningTrace.update({
        where: { id: dbTrace.id },
        data: {
          onChainTraceId,
          ...(publishTxHash ? { publishTxHash } : {}),
          lastAuditStatus: classified.status,
          lastAuditedAt: new Date(),
        },
      });
      relinked++;
    } else if (dbTrace) {
      await prisma.reasoningTrace.update({
        where: { id: dbTrace.id },
        data: {
          lastAuditStatus: classified.status,
          lastAuditedAt: new Date(),
          verified: classified.status === TraceAuditStatus.VERIFIED,
        },
      });
    }

    // Persist audit result
    await prisma.traceAudit.upsert({
      where: {
        onChainTraceId_runId: {
          onChainTraceId,
          runId,
        },
      },
      create: {
        runId,
        onChainTraceId,
        traceId: dbTrace?.id ?? null,
        onChainMarketId: onChain?.market_id ?? null,
        agent: onChain?.agent ?? null,
        action: onChain?.action ?? null,
        ipfsCid: onChain?.ipfs_cid ?? null,
        onChainHash: classified.onChainHash ?? null,
        computedHash: classified.computedHash ?? null,
        status: classified.status,
        detail: classified.detail ? (classified.detail as any) : undefined,
      },
      update: {
        status: classified.status,
        detail: classified.detail ? (classified.detail as any) : undefined,
      },
    });
  }

  // Also audit any DB traces that have no onChainTraceId to catch NOT_ON_CHAIN / dry-run states
  const unlinkedTraces = await prisma.reasoningTrace.findMany({
    where: { onChainTraceId: null, lastAuditStatus: null },
    take: 20,
    select: { id: true, traceHash: true, ipfsCid: true, marketId: true },
  });

  for (const t of unlinkedTraces) {
    const classified = classify({
      onChain: null,
      db: t as any,
      fetched: null,
      knownAgents,
      isArchived: false,
    });

    counts[classified.status] = (counts[classified.status] || 0) + 1;
    totalAudited++;

    await prisma.traceAudit.create({
      data: {
        runId,
        onChainTraceId: null,
        traceId: t.id,
        status: classified.status,
        detail: classified.detail ? (classified.detail as any) : undefined,
      },
    });

    await prisma.reasoningTrace.update({
      where: { id: t.id },
      data: {
        lastAuditStatus: classified.status,
        lastAuditedAt: new Date(),
        verified: false,
      },
    });
  }

  const finishedAt = new Date();
  await prisma.traceAuditRun.update({
    where: { id: runId },
    data: {
      finishedAt,
      cursorTraceId: nextCursor,
      stats: { totalAudited, counts, relinked, rpcCalls, fetches },
    },
  });

  return {
    runId,
    totalAudited,
    counts,
    relinked,
    rpcCalls,
    fetches,
  };
}
