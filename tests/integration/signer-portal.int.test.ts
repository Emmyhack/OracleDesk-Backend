import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { integrationEnv, skipReason } from './setup';

let db: Awaited<ReturnType<typeof integrationEnv>>;
let prisma: import('@prisma/client').PrismaClient;
let portal: typeof import('../../src/services/signer-portal.service');
let truncateAll: typeof import('../helpers/db').truncateAll;
let restore: () => void;

before(async () => {
  db = await integrationEnv('signer-portal');
  if (!db) return;
  prisma = (await import('../../src/lib/prisma')).prisma;
  portal = await import('../../src/services/signer-portal.service');
  truncateAll = (await import('../helpers/db')).truncateAll;
  restore = portal.setSignerPortalDeps({ resolverState: async () => 'SignersPending' });
});
beforeEach(async () => { if (db) await truncateAll(prisma); });
after(async () => {
  if (!db) return;
  restore();
  await prisma.$disconnect();
  await db.drop();
});

const signer = Keypair.random().publicKey();
const other = Keypair.random().publicKey();
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

let nextId = 100n;
async function market(spec: unknown, over: Record<string, unknown> = {}) {
  return prisma.market.create({
    data: {
      question: 'Q?',
      category: 'FED',
      initialYesProb: 0.5,
      confidenceInterval: { lower: 0.4, upper: 0.6 },
      expiryTimestamp: hours(-1),
      onChainMarketId: nextId++,
      resolutionSpec: spec as never,
      ...over,
    } as never,
  });
}
const signersSpec = (...signers: string[]) => ({ kind: 'signers', signers, threshold: 1, disputeWindow: 60 });

test('listing selects closed markets that name the wallet in their committed signer set', { skip: skipReason() }, async () => {
  const mine = await market(signersSpec(signer, other));
  await market(signersSpec(other));                                         // not a signer here
  await market(signersSpec(signer), { expiryTimestamp: hours(5) });          // not closed yet
  await market({ kind: 'price', reflector: 'C', asset: { kind: 'other', symbol: 'X' } }); // price mode
  await market(signersSpec(signer), { onChainMarketId: null });               // not on-chain
  await market(signersSpec(signer), { status: 'RESOLVED' });                  // already resolved

  const page = await portal.listAwaiting(signer, { page: 1, limit: 20 });
  assert.deepEqual(page.items.map((i) => i.marketId), [mine.id]);
  assert.equal(page.items[0].onChainMarketId, mine.onChainMarketId!.toString());
});

test('listing excludes markets this signer already attested to, but not other signers\' attestations', { skip: skipReason() }, async () => {
  const done = await market(signersSpec(signer));
  const waiting = await market(signersSpec(signer));
  const stillPrepared = await market(signersSpec(signer));
  const row = (m: { id: string; onChainMarketId: bigint | null }, who: string, status: string) =>
    prisma.signerAttestation.create({
      data: { marketId: m.id, onChainMarketId: m.onChainMarketId!, signer: who, outcome: 'YES', status, preparedXdr: 'x', preparedHash: 'h', validUntil: hours(1) },
    });
  await row(done, signer, 'CONFIRMED');
  await row(waiting, other, 'CONFIRMED');
  await row(stillPrepared, signer, 'PREPARED');

  const page = await portal.listAwaiting(signer, { page: 1, limit: 20 });
  assert.deepEqual(page.items.map((i) => i.marketId).sort(), [stillPrepared.id, waiting.id].sort());
  assert.deepEqual(page.items.find((i) => i.marketId === stillPrepared.id)!.preparedOutcomes, ['YES']);
});

test('one attestation row per (market, signer, outcome)', { skip: skipReason() }, async () => {
  const m = await market(signersSpec(signer));
  const data = { marketId: m.id, onChainMarketId: m.onChainMarketId!, signer, outcome: 'YES', status: 'PREPARED', preparedXdr: 'x', preparedHash: 'h', validUntil: hours(1) };
  await prisma.signerAttestation.create({ data });
  await assert.rejects(prisma.signerAttestation.create({ data }), /Unique constraint/);
  await prisma.signerAttestation.create({ data: { ...data, outcome: 'NO' } });
});

test('the migration created a GIN index on markets.resolutionSpec that serves the containment query', { skip: skipReason() }, async () => {
  const idx = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'markets' AND indexdef ILIKE '%gin%resolutionSpec%'`,
  );
  assert.equal(idx.length, 1);
});
