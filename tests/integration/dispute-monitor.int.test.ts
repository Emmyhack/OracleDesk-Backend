import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { integrationEnv, skipReason } from './setup';

let db: Awaited<ReturnType<typeof integrationEnv>>;
let prisma: import('@prisma/client').PrismaClient;
let monitor: typeof import('../../src/services/dispute-monitor.service');
let alerts: typeof import('../../src/services/alerts.service');
let portal: typeof import('../../src/services/signer-portal.service');
let truncateAll: typeof import('../helpers/db').truncateAll;
let spec: { kind: 'signers'; signers: string[]; threshold: number; disputeWindow: number };

before(async () => {
  db = await integrationEnv('dispute-monitor');
  if (!db) return;
  prisma = (await import('../../src/lib/prisma')).prisma;
  monitor = await import('../../src/services/dispute-monitor.service');
  alerts = await import('../../src/services/alerts.service');
  portal = await import('../../src/services/signer-portal.service');
  truncateAll = (await import('../helpers/db')).truncateAll;
  spec = { kind: 'signers', signers: [Keypair.random().publicKey()], threshold: 1, disputeWindow: 3600 };
});
beforeEach(async () => { if (db) await truncateAll(prisma); });
after(async () => {
  if (!db) return;
  await prisma.$disconnect();
  await db.drop();
});

async function signerMarket(onChainMarketId: bigint, overrides: Record<string, unknown> = {}) {
  const { resolutionHash } = await import('../../src/lib/resolution-spec');
  return prisma.market.create({
    data: {
      question: 'Q?', category: 'FED', initialYesProb: 0.5, confidenceInterval: { lower: 0.4, upper: 0.6 },
      expiryTimestamp: new Date(Date.now() - 3_600_000), onChainMarketId,
      resolutionSpec: spec as never, resolutionHash: resolutionHash(spec).toString('hex'), ...overrides,
    } as never,
  });
}

test('one review per proposal event id, enforced by the database', { skip: skipReason() }, async () => {
  await signerMarket(7n);
  const event = { id: 'evt-1', params: { market_id: '7', outcome: { tag: 'Yes' }, proposed_at: '1700000000' } };
  const [a, b] = await Promise.all([monitor.recordProposal(event), monitor.recordProposal(event)]);
  assert.equal([a, b].filter((r) => r.created).length, 1, 'concurrent replays create exactly one row');
  assert.equal(await prisma.disputeReview.count(), 1);
  const row = await prisma.disputeReview.findFirstOrThrow();
  assert.equal(row.verdict, 'PENDING');
  assert.equal(row.windowEndsAt, 1_700_000_000n + 3600n);
});

test('alert deliveries are unique per review, level and sink', { skip: skipReason() }, async () => {
  const sent: string[] = [];
  const sink = { name: 'a', send: async (alert: { level: string }) => { sent.push(alert.level); } };
  const service = new alerts.AlertService({ sinks: [sink], sleep: async () => undefined });
  const alert = { level: 'CRITICAL' as const, title: 't', marketId: 'm', onChainMarketId: '7', proposedOutcome: 'YES', verdict: 'DISAGREE', windowRemainingSecs: 1, links: { market: '/m', cancelTx: '/c' } };
  await Promise.all([service.send('review-1', alert), service.send('review-1', alert)]).catch(() => undefined);
  await service.send('review-1', alert);
  assert.equal(await prisma.alertDelivery.count({ where: { dedupeKey: 'review-1:CRITICAL:a' } }), 1);
  assert.equal((await prisma.alertDelivery.findFirstOrThrow()).status, 'SENT');
});

test('the polling fallback selects only closed signer-mode markets by their JSON spec', { skip: skipReason() }, async () => {
  const wanted = await signerMarket(11n);
  await signerMarket(12n, { resolutionSpec: { kind: 'price', reflector: 'C', asset: { kind: 'other', symbol: 'X' } } });
  await signerMarket(13n, { expiryTimestamp: new Date(Date.now() + 3_600_000) });
  await signerMarket(14n, { status: 'RESOLVED' });

  const probed: bigint[] = [];
  const probe = {
    resolverState: async (id: bigint) => { probed.push(id); return 'SignersPending'; },
    finalizeProbe: async () => 'WINDOW_OPEN' as const,
  };
  const deps = { evaluator: { evaluate: async () => ({ outcome: null, confidence: 0, evidence: [] }) }, alerts: new alerts.AlertService({ sinks: [] }), clock: () => new Date() };
  const result = await monitor.pollProposals(deps, probe);
  assert.deepEqual(probed, [11n]);
  assert.equal(result.created, 1);
  const review = await prisma.disputeReview.findFirstOrThrow();
  assert.equal(review.onChainMarketId, wanted.onChainMarketId);
  assert.equal(review.proposalEventId, 'missed:11:1');
  assert.equal(review.proposedAt, null);
});

test('progress finds the ResolutionProposed event for a market by its JSON params', { skip: skipReason() }, async () => {
  const m = await signerMarket(21n);
  const restore = portal.setSignerPortalDeps({
    onChainResolutionHash: async () => m.resolutionHash!,
    resolverState: async () => 'SignersPending',
  });
  try {
    const row = (id: string, market: string, outcome: string, ledger: number) =>
      prisma.chainEvent.create({
        data: {
          id, contractId: 'C', contractName: 'resolver', eventName: 'ResolutionProposed', ledger,
          ledgerClosedAt: new Date(), txHash: 'ab'.repeat(32), published: true,
          params: { market_id: market, outcome: { tag: outcome }, proposed_at: '1700000000' },
        },
      });
    await row('e-1', '99', 'No', 5);   // another market
    await row('e-2', '21', 'No', 6);   // an earlier proposal, since cancelled
    await row('e-3', '21', 'Yes', 9);  // the latest one wins
    const progress = await portal.getProgress(m.id, spec.signers[0]);
    assert.deepEqual(progress.proposal, { outcome: 'YES', proposedAt: '1700000000' });
  } finally {
    restore();
  }
});

test('chain_events rows default to unpublished and are indexed for the publisher', { skip: skipReason() }, async () => {
  const created = await prisma.chainEvent.create({
    data: { id: 'x-1', contractId: 'C', contractName: 'marketCore', eventName: 'Trade', ledger: 1, ledgerClosedAt: new Date(), txHash: 'ab'.repeat(32), params: {} },
  });
  assert.equal(created.published, false);
  const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'chain_events' AND indexname = 'chain_events_published_ledger_idx'`,
  );
  assert.equal(idx.length, 1);
});
