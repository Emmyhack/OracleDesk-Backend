import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { writeAgentLog } from '../lib/agent-log';
import { CONTRACTS } from '../config/contracts';
import { getTransactionReader } from './stellar/tx-inspect';
import { getOnChainMarket, marketCount } from './chain.service';
import type { Market as OnChainMarket } from '../generated/market-core';
import { readContractEvents } from './stellar/tx-inspect';

export interface MarketCreationAttemptRow {
  id: string;
  market_id: string;
  status: 'CLAIMED' | 'SUBMITTED' | 'LANDED' | 'UNKNOWN' | 'EXPIRED';
  attempts: number;
  claimed_at: Date | null;
  claim_lease_expires_at: Date | null;
  question_hash: string | null;
  resolution_hash: string | null;
  pre_submission_market_count: bigint | null;
  post_submission_market_count: bigint | null;
  tx_hash: string | null;
  on_chain_market_id: bigint | null;
  created_at: Date;
  updated_at: Date;
}

/** Dependency injection seam for discovery and chain inspections (#41). */
export const marketCreationDeps = {
  getMarketCount: async () => marketCount(),
  getOnChainMarket: async (id: bigint) => getOnChainMarket(id),
  getTransaction: async (hash: string) => getTransactionReader().getTransaction(hash),
  maxScanMarkets: 50,
  scanConcurrency: 4,
};

/**
 * Claims market creation atomically using insert-on-conflict-do-nothing
 * followed by a locked select. Fencing on the `attempts` counter prevents
 * races with slow or resumed workers (#41).
 */
export async function claimCreation(
  marketId: string,
  leaseSeconds = 60,
): Promise<{ acquired: boolean; attempt: MarketCreationAttemptRow | null }> {
  // 1. Insert on conflict do nothing
  await prisma.$executeRaw`
    INSERT INTO "market_creation_attempts" (
      "id", "market_id", "status", "attempts", "claimed_at", "claim_lease_expires_at", "created_at", "updated_at"
    ) VALUES (
      gen_random_uuid(), ${marketId}, 'CLAIMED', 0, NOW(), NOW() + (${leaseSeconds} * interval '1 second'), NOW(), NOW()
    ) ON CONFLICT ("market_id") DO NOTHING;
  `;

  // 2. Interactive transaction with locked select
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<MarketCreationAttemptRow[]>`
      SELECT * FROM "market_creation_attempts"
      WHERE "market_id" = ${marketId}
      FOR UPDATE;
    `;

    if (!rows || rows.length === 0) {
      return { acquired: false, attempt: null };
    }

    const current = rows[0];

    // Already successfully landed on-chain
    if (current.status === 'LANDED') {
      return { acquired: false, attempt: current };
    }

    const now = new Date();
    const leaseActive = current.claim_lease_expires_at && new Date(current.claim_lease_expires_at) > now;

    // Actively claimed by another process
    if (current.status === 'CLAIMED' && leaseActive) {
      return { acquired: false, attempt: current };
    }

    // Claim is stale, or retry allowed (status EXPIRED or UNKNOWN).
    // Fencing check: update only if attempts matches seen counter.
    const updated = await tx.$executeRaw`
      UPDATE "market_creation_attempts"
      SET "status" = 'CLAIMED',
          "attempts" = "attempts" + 1,
          "claimed_at" = NOW(),
          "claim_lease_expires_at" = NOW() + (${leaseSeconds} * interval '1 second'),
          "updated_at" = NOW()
      WHERE "market_id" = ${marketId} AND "attempts" = ${current.attempts};
    `;

    if (updated === 1) {
      const refreshed = await tx.$queryRaw<MarketCreationAttemptRow[]>`
        SELECT * FROM "market_creation_attempts"
        WHERE "market_id" = ${marketId};
      `;
      return { acquired: true, attempt: refreshed[0] ?? current };
    }

    return { acquired: false, attempt: current };
  });
}

/**
 * Releases an active claim lease so other workers can retry if needed.
 */
export async function releaseClaim(marketId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "market_creation_attempts"
    SET "claim_lease_expires_at" = NOW(),
        "updated_at" = NOW()
    WHERE "market_id" = ${marketId} AND "status" = 'CLAIMED';
  `.catch(() => undefined);
}

/**
 * Discovers whether a market landed on-chain across ambiguous outcomes (#41):
 * 1. Checks stored transaction hash via RPC getTransaction.
 * 2. Checks indexed MarketCreated events in chain_events table.
 * 3. Bounded backwards scan from marketCount.
 * Every candidate is confirmed by reading on-chain market and matching question_hash,
 * resolution_hash, and verifying that the creator is the treasury (not the agent).
 */
export async function discoverLandedMarket(params: {
  marketId: string;
  questionHashHex: string;
  resolutionHashHex: string;
  txHash?: string | null;
  preSubmissionCount?: bigint | null;
}): Promise<bigint | null> {
  const normQ = params.questionHashHex.toLowerCase().replace(/^0x/, '');
  const normR = params.resolutionHashHex.toLowerCase().replace(/^0x/, '');
  const treasuryContract = CONTRACTS.treasury.toUpperCase();

  const isConfirmedCandidate = (onChain: OnChainMarket): boolean => {
    const q = Buffer.from(onChain.question_hash as any).toString('hex').toLowerCase();
    const r = Buffer.from(onChain.resolution_hash as any).toString('hex').toLowerCase();
    const creator = String(onChain.creator).toUpperCase();
    return q === normQ && r === normR && creator === treasuryContract;
  };

  // ── Step 1: Check stored transaction hash ──
  if (params.txHash) {
    try {
      const txRes = await marketCreationDeps.getTransaction(params.txHash);
      if (txRes && (txRes as any).status === 'SUCCESS') {
        const events = readContractEvents(txRes);
        for (const ev of events) {
          if (ev.name === 'MarketCreated' && ev.data?.market_id !== undefined) {
            const candId = BigInt(ev.data.market_id);
            const onChain = await marketCreationDeps.getOnChainMarket(candId);
            if (isConfirmedCandidate(onChain)) {
              logger.info({ marketId: params.marketId, onChainMarketId: candId.toString(), txHash: params.txHash }, 'Discovered market via txHash');
              return candId;
            }
          }
        }
      }
    } catch (err: any) {
      logger.debug({ err: err?.message, txHash: params.txHash }, 'txHash discovery check missed');
    }
  }

  // ── Step 2: Check indexed MarketCreated events ──
  try {
    const indexedEvents = await prisma.$queryRaw<Array<{ params: any; tx_hash: string }>>`
      SELECT params, tx_hash FROM "chain_events"
      WHERE "event_name" = 'MarketCreated'
      ORDER BY "ledger" DESC
      LIMIT 100;
    `;

    for (const ev of indexedEvents) {
      const p = typeof ev.params === 'string' ? JSON.parse(ev.params) : ev.params;
      const q = String(p?.question_hash ?? '').toLowerCase().replace(/^0x/, '');
      const creator = String(p?.creator ?? '').toUpperCase();
      if (q === normQ && creator === treasuryContract && p?.market_id !== undefined) {
        const candId = BigInt(p.market_id);
        const onChain = await marketCreationDeps.getOnChainMarket(candId);
        if (isConfirmedCandidate(onChain)) {
          logger.info({ marketId: params.marketId, onChainMarketId: candId.toString() }, 'Discovered market via indexed MarketCreated event');
          return candId;
        }
      }
    }
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'Indexed events discovery check missed');
  }

  // ── Step 3: Bounded on-chain market scan ──
  try {
    const currentCount = await marketCreationDeps.getMarketCount();
    const floor = params.preSubmissionCount !== null && params.preSubmissionCount !== undefined
      ? params.preSubmissionCount
      : currentCount > BigInt(marketCreationDeps.maxScanMarkets)
        ? currentCount - BigInt(marketCreationDeps.maxScanMarkets)
        : 0n;

    for (let id = currentCount - 1n; id >= floor && id >= 0n; id--) {
      try {
        const onChain = await marketCreationDeps.getOnChainMarket(id);
        if (isConfirmedCandidate(onChain)) {
          logger.info({ marketId: params.marketId, onChainMarketId: id.toString() }, 'Discovered market via bounded scan');
          return id;
        }
      } catch (err: any) {
        // Missing market terminates the backwards scan
        if (err?.message?.includes('MarketNotFound') || err?.contractError === 'MarketNotFound') {
          break;
        }
      }
    }
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'Bounded scan discovery check missed');
  }

  return null;
}

/**
 * Links a discovered or landed market to both the market and attempt records
 * within a single transaction. A unique violation on `onChainMarketId` logs
 * CREATION_ID_CONFLICT and never overwrites (#41).
 */
export async function linkLandedMarket(
  marketId: string,
  onChainMarketId: bigint,
  txHash?: string | null,
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.market.update({
        where: { id: marketId },
        data: {
          onChainMarketId,
          creationTxHash: txHash ?? undefined,
          status: 'ACTIVE',
        },
      });

      await tx.marketCreationAttempt.upsert({
        where: { marketId },
        create: {
          marketId,
          onChainMarketId,
          txHash: txHash ?? null,
          status: 'LANDED',
        },
        update: {
          onChainMarketId,
          txHash: txHash ?? undefined,
          status: 'LANDED',
          claimLeaseExpiresAt: new Date(),
        },
      });
    });
    return true;
  } catch (err: any) {
    // Unique violation on onChainMarketId (P2002)
    if (err?.code === 'P2002' || err?.message?.includes('Unique constraint')) {
      logger.error({ marketId, onChainMarketId: onChainMarketId.toString() }, 'CREATION_ID_CONFLICT: on-chain market id already linked');
      await writeAgentLog({
        agentType: 'MARKET_MAKER',
        level: 'ERROR',
        action: 'CREATION_ID_CONFLICT',
        marketId,
        data: { onChainMarketId: onChainMarketId.toString(), err: err.message },
      }).catch(() => undefined);
      return false;
    }
    throw err;
  }
}

/**
 * Sweeps and reconciles unresolved attempts in UNKNOWN or EXPIRED status (#41).
 */
export async function reconcileUnresolvedAttempts(): Promise<number> {
  const unresolved = await prisma.marketCreationAttempt.findMany({
    where: {
      status: { in: ['UNKNOWN', 'EXPIRED'] },
      market: { onChainMarketId: null },
    },
    include: { market: true },
    take: 20,
  });

  let linkedCount = 0;
  for (const attempt of unresolved) {
    if (!attempt.questionHash || !attempt.resolutionHash) continue;
    try {
      const landedId = await discoverLandedMarket({
        marketId: attempt.marketId,
        questionHashHex: attempt.questionHash,
        resolutionHashHex: attempt.resolutionHash,
        txHash: attempt.txHash,
        preSubmissionCount: attempt.preSubmissionMarketCount,
      });

      if (landedId !== null) {
        const ok = await linkLandedMarket(attempt.marketId, landedId, attempt.txHash);
        if (ok) linkedCount++;
      }
    } catch (err: any) {
      logger.warn({ marketId: attempt.marketId, err: err?.message }, 'Failed to reconcile market creation attempt');
    }
  }

  if (linkedCount > 0) {
    logger.info({ linkedCount }, 'Reconciled unresolved market creation attempts');
  }
  return linkedCount;
}
