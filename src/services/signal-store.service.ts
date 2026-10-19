/**
 * The signal store (#73): normalised evidence rows with stable identities,
 * near-duplicate clusters, a log of provider calls and raw payloads with
 * bounded retention.
 *
 * `prismaSignalStore` is production. Writes go through one batched
 * `INSERT … ON CONFLICT ("dedupKey") DO UPDATE` per 100 rows (a per-row Prisma
 * upsert is slow and races on the unique key across replicas).
 * `MemorySignalStore` implements the same contract in memory for tests and
 * replays.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { CLUSTER_WINDOW_HOURS, chooseCluster, type ClusterCandidate } from './signal-normalize';

export interface NormalizedSignal {
  source: string;
  dedupKey: string;
  externalId: string | null;
  url: string | null;
  publisher: string | null;
  title: string;
  summary: string | null;
  publishedAt: Date;
  category: string | null;
  categoryConfidence: number | null;
  numericValue: number | null;
  simhash: bigint | null;
}

export interface SignalRow extends NormalizedSignal {
  id: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
  clusterId: string | null;
}

export interface UpsertResult {
  id: string;
  dedupKey: string;
  clusterId: string | null;
  /** False when the row already existed and only lastSeenAt/seenCount moved. */
  inserted: boolean;
}

export type FetchStatus = 'ok' | 'error' | 'timeout' | 'skipped_no_key';

export interface FetchRecord {
  source: string;
  requestFingerprint: string;
  startedAt: Date;
  durationMs: number;
  status: FetchStatus;
  itemCount: number;
  rejectedCount: number;
  error: string | null;
  /** Provider JSON with credentials already stripped; stored in signal_raw_payloads. */
  rawPayload?: unknown;
}

export interface PurgeOptions {
  rawBefore: Date;
  fetchesBefore: Date;
  /** Unreferenced signals last seen before this are deleted. */
  signalsBefore: Date;
  batchSize?: number;
}

export interface PurgeResult {
  rawPayloads: number;
  fetches: number;
  signals: number;
}

export interface SignalStore {
  upsert(rows: NormalizedSignal[], now: Date): Promise<UpsertResult[]>;
  /** Near-dup candidates published since `since` in these categories (null = uncategorised). */
  clusterCandidates(since: Date, categories: Array<string | null>): Promise<ClusterCandidate[]>;
  /** Sets clusterId on rows that do not have one yet. */
  setClusters(assignments: Array<{ id: string; clusterId: string }>): Promise<void>;
  recordFetch(f: FetchRecord): Promise<void>;
  lastSuccessfulFetch(source: string): Promise<Date | null>;
  /** Signals last seen at or after `since`. */
  recent(since: Date): Promise<SignalRow[]>;
  purge(opts: PurgeOptions): Promise<PurgeResult>;
}

export const UPSERT_BATCH_SIZE = 100;

/** Last row wins inside one batch: ON CONFLICT cannot touch a row twice in one statement. */
function dedupeBatch(rows: NormalizedSignal[]): NormalizedSignal[] {
  const byKey = new Map<string, NormalizedSignal>();
  for (const r of rows) byKey.set(r.dedupKey, r);
  return [...byKey.values()];
}

// ─── Prisma ───────────────────────────────────────────────────────────────────

export const prismaSignalStore: SignalStore = {
  async upsert(rows, now) {
    const out: UpsertResult[] = [];
    const unique = dedupeBatch(rows);
    for (let i = 0; i < unique.length; i += UPSERT_BATCH_SIZE) {
      const batch = unique.slice(i, i + UPSERT_BATCH_SIZE);
      const values = batch.map((r) => Prisma.sql`(
        ${randomUUID()}, ${r.source}, ${r.dedupKey}, ${r.externalId}, ${r.url}, ${r.publisher},
        ${r.title}, ${r.summary}, ${r.publishedAt}, ${now}, ${now}, 1,
        CAST(${r.category} AS "MarketCategory"), ${r.categoryConfidence}, ${r.numericValue}, ${r.simhash}
      )`);
      const returned = await prisma.$queryRaw<Array<{ id: string; dedupKey: string; clusterId: string | null; inserted: boolean }>>`
        INSERT INTO "signals" (
          "id", "source", "dedupKey", "externalId", "url", "publisher",
          "title", "summary", "publishedAt", "firstSeenAt", "lastSeenAt", "seenCount",
          "category", "categoryConfidence", "numericValue", "simhash"
        )
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("dedupKey") DO UPDATE SET
          "lastSeenAt" = EXCLUDED."lastSeenAt",
          "seenCount"  = "signals"."seenCount" + 1,
          "url"        = COALESCE("signals"."url", EXCLUDED."url"),
          "publisher"  = COALESCE("signals"."publisher", EXCLUDED."publisher")
        RETURNING "id", "dedupKey", "clusterId", (xmax = 0) AS "inserted"`;
      out.push(...returned);
    }
    return out;
  },

  async clusterCandidates(since, categories) {
    const named = categories.filter((c): c is string => c !== null);
    const rows = await prisma.signal.findMany({
      where: {
        publishedAt: { gte: since },
        source: { not: 'FRED' },
        OR: [
          ...(named.length > 0 ? [{ category: { in: named as any } }] : []),
          ...(categories.includes(null) ? [{ category: null }] : []),
        ],
      },
      select: { id: true, clusterId: true, title: true, summary: true, simhash: true, firstSeenAt: true },
    });
    return rows;
  },

  async setClusters(assignments) {
    for (let i = 0; i < assignments.length; i += UPSERT_BATCH_SIZE) {
      const batch = assignments.slice(i, i + UPSERT_BATCH_SIZE);
      const values = batch.map((a) => Prisma.sql`(${a.id}, ${a.clusterId})`);
      await prisma.$executeRaw`
        UPDATE "signals" AS s SET "clusterId" = v.cid
        FROM (VALUES ${Prisma.join(values)}) AS v(id, cid)
        WHERE s."id" = v.id AND s."clusterId" IS NULL`;
    }
  },

  async recordFetch(f) {
    let rawPayloadId: string | null = null;
    if (f.rawPayload !== undefined) {
      const raw = await prisma.signalRawPayload.create({
        data: { source: f.source, payload: f.rawPayload as Prisma.InputJsonValue, createdAt: f.startedAt },
        select: { id: true },
      });
      rawPayloadId = raw.id;
    }
    await prisma.signalFetch.create({
      data: {
        source: f.source,
        requestFingerprint: f.requestFingerprint,
        startedAt: f.startedAt,
        durationMs: f.durationMs,
        status: f.status,
        itemCount: f.itemCount,
        rejectedCount: f.rejectedCount,
        error: f.error,
        rawPayloadId,
      },
    });
  },

  async lastSuccessfulFetch(source) {
    const row = await prisma.signalFetch.findFirst({
      where: { source, status: 'ok' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    return row?.startedAt ?? null;
  },

  async recent(since) {
    const rows = await prisma.signal.findMany({
      where: { lastSeenAt: { gte: since } },
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
      take: 2_000,
    });
    return rows.map((r) => ({ ...r, category: r.category ?? null }));
  },

  async purge({ rawBefore, fetchesBefore, signalsBefore, batchSize = 1_000 }) {
    const rawPayloads = (await prisma.signalRawPayload.deleteMany({ where: { createdAt: { lt: rawBefore } } })).count;
    const fetches = (await prisma.signalFetch.deleteMany({ where: { startedAt: { lt: fetchesBefore } } })).count;
    // Bounded batches; a signal cited by any trace (sourcesUsed @> [{signalId}],
    // served by the jsonb_path_ops GIN index) is never deleted.
    let signals = 0;
    for (;;) {
      const n = await prisma.$executeRaw`
        DELETE FROM "signals" WHERE "id" IN (
          SELECT s."id" FROM "signals" s
          WHERE s."lastSeenAt" < ${signalsBefore}
            AND NOT EXISTS (
              SELECT 1 FROM "reasoning_traces" t
              WHERE t."sourcesUsed" @> jsonb_build_array(jsonb_build_object('signalId', s."id"))
            )
          LIMIT ${batchSize}
        )`;
      signals += n;
      if (n < batchSize) break;
    }
    return { rawPayloads, fetches, signals };
  },
};

// ─── Memory ───────────────────────────────────────────────────────────────────

/**
 * In-memory store with the same semantics as the Prisma one, including the
 * trace-reference rule in `purge` (pass the cited ids via `citedSignalIds`).
 */
export class MemorySignalStore implements SignalStore {
  readonly rows = new Map<string, SignalRow>();
  readonly fetches: Array<FetchRecord & { id: string; rawPayloadId: string | null }> = [];
  readonly rawPayloads = new Map<string, { id: string; source: string; payload: unknown; createdAt: Date }>();
  /** Signal ids referenced by traces, for purge. */
  citedSignalIds = new Set<string>();
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(6, '0')}`;
  }

  async upsert(rows: NormalizedSignal[], now: Date): Promise<UpsertResult[]> {
    const out: UpsertResult[] = [];
    for (const r of dedupeBatch(rows)) {
      const existing = [...this.rows.values()].find((x) => x.dedupKey === r.dedupKey);
      if (existing) {
        existing.lastSeenAt = now;
        existing.seenCount += 1;
        existing.url ??= r.url;
        existing.publisher ??= r.publisher;
        out.push({ id: existing.id, dedupKey: existing.dedupKey, clusterId: existing.clusterId, inserted: false });
        continue;
      }
      const row: SignalRow = { ...r, id: this.nextId('sig'), firstSeenAt: now, lastSeenAt: now, seenCount: 1, clusterId: null };
      this.rows.set(row.id, row);
      out.push({ id: row.id, dedupKey: row.dedupKey, clusterId: null, inserted: true });
    }
    return out;
  }

  async clusterCandidates(since: Date, categories: Array<string | null>): Promise<ClusterCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.publishedAt >= since && r.source !== 'FRED' && categories.includes(r.category))
      .map(({ id, clusterId, title, summary, simhash, firstSeenAt }) => ({ id, clusterId, title, summary, simhash, firstSeenAt }));
  }

  async setClusters(assignments: Array<{ id: string; clusterId: string }>): Promise<void> {
    for (const a of assignments) {
      const row = this.rows.get(a.id);
      if (row && row.clusterId === null) row.clusterId = a.clusterId;
    }
  }

  async recordFetch(f: FetchRecord): Promise<void> {
    let rawPayloadId: string | null = null;
    if (f.rawPayload !== undefined) {
      rawPayloadId = this.nextId('raw');
      this.rawPayloads.set(rawPayloadId, { id: rawPayloadId, source: f.source, payload: f.rawPayload, createdAt: f.startedAt });
    }
    const { rawPayload: _omit, ...rest } = f;
    this.fetches.push({ ...rest, id: this.nextId('fetch'), rawPayloadId });
  }

  async lastSuccessfulFetch(source: string): Promise<Date | null> {
    const ok = this.fetches.filter((f) => f.source === source && f.status === 'ok');
    return ok.length === 0 ? null : new Date(Math.max(...ok.map((f) => f.startedAt.getTime())));
  }

  async recent(since: Date): Promise<SignalRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.lastSeenAt >= since)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || (a.id < b.id ? -1 : 1));
  }

  async purge({ rawBefore, fetchesBefore, signalsBefore }: PurgeOptions): Promise<PurgeResult> {
    let rawPayloads = 0;
    for (const [id, raw] of this.rawPayloads) if (raw.createdAt < rawBefore) { this.rawPayloads.delete(id); rawPayloads++; }
    const keep = this.fetches.filter((f) => f.startedAt >= fetchesBefore);
    const fetches = this.fetches.length - keep.length;
    this.fetches.splice(0, this.fetches.length, ...keep);
    let signals = 0;
    for (const [id, row] of this.rows) {
      if (row.lastSeenAt < signalsBefore && !this.citedSignalIds.has(id)) { this.rows.delete(id); signals++; }
    }
    return { rawPayloads, fetches, signals };
  }
}

// ─── Seam ─────────────────────────────────────────────────────────────────────

let store: SignalStore = prismaSignalStore;

/** Test seam. Pass null to restore the Prisma store. Returns the previous store. */
export function setSignalStore(next: SignalStore | null): SignalStore {
  const prev = store;
  store = next ?? prismaSignalStore;
  return prev;
}

export function getSignalStore(): SignalStore {
  return store;
}

// ─── Cluster assignment ──────────────────────────────────────────────────────

/**
 * Gives every newly inserted (non-FRED) signal a clusterId: the oldest
 * near-duplicate cluster from the last CLUSTER_WINDOW_HOURS in the same
 * category, or its own id. Rows from the same batch see each other, and an
 * unassigned row counts as the root of its own cluster, so the assignment
 * does not depend on processing order. FRED observations never cluster.
 */
export async function assignClusters(
  s: SignalStore,
  rows: NormalizedSignal[],
  upserted: UpsertResult[],
  now: Date,
): Promise<number> {
  const byKey = new Map(rows.map((r) => [r.dedupKey, r]));
  const fresh = upserted
    .filter((u) => u.inserted && u.clusterId === null)
    .map((u) => ({ id: u.id, row: byKey.get(u.dedupKey)! }))
    .filter((x) => x.row);
  if (fresh.length === 0) return 0;

  const assignments: Array<{ id: string; clusterId: string }> = [];
  for (const f of fresh.filter((x) => x.row.source === 'FRED')) assignments.push({ id: f.id, clusterId: f.id });

  const since = new Date(now.getTime() - CLUSTER_WINDOW_HOURS * 3_600_000);
  const clusterable = fresh.filter((x) => x.row.source !== 'FRED');
  for (const category of new Set(clusterable.map((x) => x.row.category))) {
    const group = clusterable.filter((x) => x.row.category === category).sort((a, b) => (a.id < b.id ? -1 : 1));
    // The candidates include this batch's rows (still unassigned).
    const candidates = await s.clusterCandidates(since, [category]);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    for (const f of group) {
      const clusterId = chooseCluster(f.row, candidates.filter((c) => c.id !== f.id)) ?? f.id;
      assignments.push({ id: f.id, clusterId });
      const self = byId.get(f.id);
      if (self) self.clusterId = clusterId;
    }
  }
  await s.setClusters(assignments);
  return assignments.length;
}

// ─── Retention ────────────────────────────────────────────────────────────────

export const FETCH_RETENTION_DAYS = 30;
export const SIGNAL_RETENTION_DAYS = 30;

/** Nightly retention: raw payloads, fetch logs, then unreferenced old signals. */
export async function purgeSignalStore(now = new Date(), s: SignalStore = store): Promise<PurgeResult> {
  const day = 86_400_000;
  const result = await s.purge({
    rawBefore: new Date(now.getTime() - config.SIGNAL_RAW_RETENTION_DAYS * day),
    fetchesBefore: new Date(now.getTime() - FETCH_RETENTION_DAYS * day),
    signalsBefore: new Date(now.getTime() - SIGNAL_RETENTION_DAYS * day),
  });
  logger.info(result, 'Signal store retention complete');
  return result;
}
