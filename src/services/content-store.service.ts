/**
 * Local, verified IPFS content store (#100).
 *
 * sha256 is the only admission criterion; the CID is a lookup key. Bytes are
 * stored at pin time (write-through) and gateway bytes are admitted only after
 * their hash matches the hash the caller already trusts (on-chain or the pin
 * hash). The store never serves bytes whose current hash differs from the
 * expected hash.
 */
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { sha256Hex } from '../utils/hash.util';

export type ContentOrigin = 'PINNED' | 'GATEWAY_VERIFIED';

export interface ContentStore {
  put(entry: {
    cid: string;
    sha256: string;
    bytes: Buffer;
    origin: ContentOrigin;
    verifiedBy: string;
  }): Promise<void>;
  get(cid: string): Promise<{ sha256: string; bytes: Buffer; origin: string } | null>;
  touch(cid: string): Promise<void>;
  evict(budgetBytes: number): Promise<{ removed: number; freedBytes: number }>;
}

const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const EVICT_BATCH = 500;

function asBuffer(bytes: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function normalizeHash(hash: string): string {
  return hash.toLowerCase().replace(/^0x/, '');
}

export const postgresContentStore: ContentStore = {
  async put(entry) {
    const bytes = asBuffer(entry.bytes);
    const expected = normalizeHash(entry.sha256);
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new AppError(400, 'IPFS_INVALID_HASH', 'sha256 must be 64 lowercase hex characters');
    }
    // Recompute rather than trusting the caller. A mismatch means a caller bug;
    // storing it would poison the cache.
    if (sha256Hex(bytes) !== expected) {
      throw new AppError(500, 'IPFS_HASH_MISMATCH', 'Content hash does not match sha256Hex(bytes)');
    }
    if (bytes.length > config.IPFS_CACHE_MAX_OBJECT_BYTES) {
      throw new AppError(413, 'IPFS_CONTENT_TOO_LARGE', 'Content exceeds IPFS_CACHE_MAX_OBJECT_BYTES', {
        size: bytes.length,
        max: config.IPFS_CACHE_MAX_OBJECT_BYTES,
      });
    }

    const existing = await prisma.ipfsContent.findUnique({ where: { cid: entry.cid } });
    if (existing) {
      if (normalizeHash(existing.sha256) !== expected) {
        logger.error(
          { cid: entry.cid, stored: existing.sha256, incoming: expected },
          'IPFS CID hash conflict — refusing to overwrite',
        );
        throw new AppError(409, 'IPFS_CID_HASH_CONFLICT', 'This CID already maps to different bytes', {
          cid: entry.cid,
        });
      }
      // Same bytes: idempotent, just keep it fresh.
      await prisma.ipfsContent.update({
        where: { cid: entry.cid },
        data: { lastAccessAt: new Date() },
      });
      return;
    }

    try {
      await prisma.ipfsContent.create({
        data: {
          cid: entry.cid,
          sha256: expected,
          size: bytes.length,
          bytes: new Uint8Array(bytes) as unknown as Uint8Array<ArrayBuffer>,
          origin: entry.origin,
          verifiedBy: entry.verifiedBy,
        },
      });
    } catch (err) {
      // Concurrent verifies of one CID: P2002 is success if the winner stored
      // the same bytes.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await prisma.ipfsContent.findUnique({ where: { cid: entry.cid } });
        if (winner && normalizeHash(winner.sha256) === expected) return;
        throw new AppError(409, 'IPFS_CID_HASH_CONFLICT', 'This CID already maps to different bytes', {
          cid: entry.cid,
        });
      }
      throw err;
    }
  },

  async get(cid) {
    const row = await prisma.ipfsContent.findUnique({ where: { cid } });
    if (!row) return null;
    return { sha256: row.sha256, bytes: asBuffer(row.bytes), origin: row.origin };
  },

  async touch(cid) {
    const cutoff = new Date(Date.now() - TOUCH_INTERVAL_MS);
    await prisma.ipfsContent.updateMany({
      where: { cid, lastAccessAt: { lt: cutoff } },
      data: { lastAccessAt: new Date() },
    });
  },

  async evict(budgetBytes) {
    const total = await prisma.ipfsContent.aggregate({ _sum: { size: true } });
    let remaining = total._sum.size ?? 0;
    if (remaining <= budgetBytes) return { removed: 0, freedBytes: 0 };

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // A single SQL statement, not N queries. Never evict content referenced by
    // an unpublished trace or a PENDING market. GATEWAY_VERIFIED rows go first;
    // PINNED rows only after 30 days.
    const rows = await prisma.$queryRaw<Array<{ cid: string; size: number }>>(Prisma.sql`
      SELECT ic."cid", ic."size"
      FROM "ipfs_content" ic
      WHERE (ic."pinnedUntil" IS NULL OR ic."pinnedUntil" < NOW())
        AND (ic."origin" = 'GATEWAY_VERIFIED' OR ic."createdAt" < ${thirtyDaysAgo})
        AND NOT EXISTS (
          SELECT 1 FROM "reasoning_traces" rt
          WHERE rt."ipfsCid" = ic."cid"
            AND (rt."onChainTraceId" IS NULL OR rt."verified" = false)
        )
        AND NOT EXISTS (
          SELECT 1 FROM "markets" m
          WHERE m."metaUri" = ('ipfs://' || ic."cid")
            AND m."status" = 'PENDING'
        )
      ORDER BY (CASE WHEN ic."origin" = 'GATEWAY_VERIFIED' THEN 0 ELSE 1 END),
               ic."lastAccessAt" ASC
      LIMIT ${EVICT_BATCH}
    `);

    const toRemove: string[] = [];
    let freedBytes = 0;
    for (const row of rows) {
      if (remaining <= budgetBytes) break;
      toRemove.push(row.cid);
      remaining -= row.size;
      freedBytes += row.size;
    }
    if (toRemove.length === 0) return { removed: 0, freedBytes: 0 };

    await prisma.ipfsContent.deleteMany({ where: { cid: { in: toRemove } } });
    logger.info({ removed: toRemove.length, freedBytes, budgetBytes }, 'Evicted IPFS content');
    return { removed: toRemove.length, freedBytes };
  },
};

let store: ContentStore = postgresContentStore;

/** Test seam, same style as setIpfsTransport. Returns the previous store. */
export function setContentStore(next: ContentStore): ContentStore {
  const prev = store;
  store = next;
  return prev;
}

export function getContentStore(): ContentStore {
  return store;
}
