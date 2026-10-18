/**
 * Post-restore reconciliation core (#146). The CLI wrapper is
 * scripts/post-restore-reconcile.ts; keeping the logic here lets tests import
 * it without spawning a process.
 */
import fs from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import { Contract, scValToNative, xdr } from '@stellar/stellar-sdk';
import { CONTRACTS, PAYMENTS_RECIPIENT } from '../config/contracts';
import { config } from '../config';
import { resolutionHash, type ResolutionSpecJson } from '../lib/resolution-spec';
import {
  CURSOR_ID,
  backfillEvents,
  decodedFromStored,
  reprojectEvent,
  type EventSource,
} from './indexer.service';
import type { verifyUsdcTransfer } from './payment-verification.service';

export const REWIND_LEDGERS_DEFAULT = 720;

export interface BackupManifest {
  createdAt?: string;
  gitSha?: string;
  migrations?: string[];
  cursors?: Array<{ id: string; lastLedger: number }>;
  maxChainEventLedger?: number | null;
  maxPaymentEventCreatedAt?: string | null;
  rowCounts?: Record<string, number>;
}

export interface ReconcileReport {
  manifest: BackupManifest;
  rpcOldestLedger: number;
  rpcLatestLedger: number;
  cursorBefore: number | null;
  cursorAfter: number;
  eventGap: { from: number; to: number } | null;
  reprojected: number;
  newEvents: number;
  payments: {
    reverified: number;
    failed: Array<{ txHash: string; code: string }>;
    unverifiable: number;
  };
  specs: { checked: number; missing: string[]; hashMismatch: string[] };
  unclaimedTransfers: Array<{ txHash: string; from: string; amountRaw: string; ledger: number }>;
}

export interface ReconcileDeps {
  prisma: PrismaClient;
  source: EventSource;
  verifyPayment: typeof verifyUsdcTransfer;
  emit?: (event: string, payload: unknown) => void;
}

interface Args {
  manifest?: string;
  out?: string;
  rewindLedgers: number;
  scanTransfers: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rewindLedgers: REWIND_LEDGERS_DEFAULT, scanTransfers: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest') args.manifest = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--rewind-ledgers') args.rewindLedgers = Number(argv[++i]);
    else if (arg === '--scan-transfers') args.scanTransfers = true;
  }
  return args;
}

/** A fake getEvents source used by the restore drill and tests. */
export function fixtureSource(file: string): EventSource {
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = (fixture.events ?? fixture).map((event: any) => ({
    ...event,
    contractId: new Contract(event.contractId),
    topic: event.topic.map((t: string) => xdr.ScVal.fromXDR(t, 'base64')),
    value: xdr.ScVal.fromXDR(event.value, 'base64'),
  }));
  return {
    async getHealth() {
      const ledgers = events.map((e: any) => e.ledger);
      return {
        status: 'healthy',
        oldestLedger: Math.min(...ledgers),
        latestLedger: Math.max(...ledgers),
        ledgerRetentionWindow: 120960,
      } as any;
    },
    async getEvents() {
      return {
        events,
        cursor: 'end',
        latestLedger: Math.max(...events.map((e: any) => e.ledger)),
        oldestLedger: Math.min(...events.map((e: any) => e.ledger)),
      } as any;
    },
  };
}

export async function reconcile(
  args: Args,
  deps: ReconcileDeps,
  manifest: BackupManifest,
): Promise<ReconcileReport> {
  const { prisma, source, verifyPayment } = deps;
  const health = await source.getHealth();
  const cursorRow = await prisma.indexerCursor.findUnique({ where: { id: CURSOR_ID } });
  if (!cursorRow) {
    throw new Error(
      `No indexer cursor for ${CURSOR_ID}. The backup belongs to a different network passphrase.`,
    );
  }

  const cursorBefore = cursorRow.lastLedger;
  const boundary = manifest.maxChainEventLedger ?? cursorBefore;
  const requestedSafe = Math.min(boundary, cursorBefore) - args.rewindLedgers;
  const safeLedger = Math.max(health.oldestLedger, requestedSafe);
  const eventGap =
    requestedSafe < health.oldestLedger
      ? { from: requestedSafe, to: health.oldestLedger - 1 }
      : null;

  const backfill = await backfillEvents(safeLedger, {
    source,
    emit: deps.emit ?? (() => undefined),
  });

  const stored = await prisma.chainEvent.findMany({
    where: { ledger: { gte: safeLedger } },
    orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
  });
  for (const row of stored) {
    await reprojectEvent(decodedFromStored(row as any));
  }

  const payments = { reverified: 0, failed: [] as Array<{ txHash: string; code: string }>, unverifiable: 0 };
  const confirmed = await prisma.paymentEvent.findMany({ where: { status: 'CONFIRMED' } });
  for (const payment of confirmed) {
    try {
      await verifyPayment({
        txHash: payment.txHash,
        token: CONTRACTS.usdc,
        from: payment.fromAddress ?? '',
        to: PAYMENTS_RECIPIENT,
        minAmount: BigInt(config.DAILY_PASS_PRICE_RAW),
      });
      payments.reverified++;
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'PAYMENT_VERIFY_FAILED';
      if (code === 'PAYMENT_NOT_FOUND') payments.unverifiable++;
      else payments.failed.push({ txHash: payment.txHash, code });
    }
  }

  const specs = { checked: 0, missing: [] as string[], hashMismatch: [] as string[] };
  const markets = await prisma.market.findMany({
    where: { resolutionHash: { not: null } },
    select: { id: true, resolutionHash: true, resolutionSpec: true },
  });
  for (const market of markets) {
    specs.checked++;
    if (!market.resolutionSpec) {
      specs.missing.push(market.id);
      continue;
    }
    const computed = resolutionHash(market.resolutionSpec as unknown as ResolutionSpecJson).toString('hex');
    if (computed !== market.resolutionHash) specs.hashMismatch.push(market.id);
  }

  const unclaimedTransfers: ReconcileReport['unclaimedTransfers'] = [];
  if (args.scanTransfers) {
    try {
      const page = await source.getEvents({
        startLedger: safeLedger,
        filters: [{ type: 'contract', contractIds: [CONTRACTS.usdc] }],
        limit: 200,
      });
      for (const event of page.events) {
        const topics = event.topic ?? [];
        if (topics.length < 3) continue;
        const name = scValToNative(topics[0]);
        if (name !== 'transfer') continue;
        const from = String(scValToNative(topics[1]));
        const to = String(scValToNative(topics[2]));
        if (to !== PAYMENTS_RECIPIENT) continue;
        const amount = scValToNative(event.value);
        const txHash = event.txHash;
        const existing = await prisma.paymentEvent.findUnique({ where: { txHash } });
        if (!existing) {
          unclaimedTransfers.push({ txHash, from, amountRaw: String(amount), ledger: event.ledger });
        }
      }
    } catch {
      // Scanning is best-effort; a retention gap is reported separately.
    }
  }

  const after = await prisma.indexerCursor.findUnique({ where: { id: CURSOR_ID } });
  return {
    manifest,
    rpcOldestLedger: health.oldestLedger,
    rpcLatestLedger: health.latestLedger,
    cursorBefore,
    cursorAfter: after?.lastLedger ?? backfill.lastLedger,
    eventGap,
    reprojected: stored.length,
    newEvents: backfill.stored,
    payments,
    specs,
    unclaimedTransfers,
  };
}

