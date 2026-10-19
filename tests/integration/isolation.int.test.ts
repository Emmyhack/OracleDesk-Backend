import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationEnv, skipReason } from './setup';

let db: Awaited<ReturnType<typeof integrationEnv>>;
let prisma: import('@prisma/client').PrismaClient;
let truncateAll: typeof import('../helpers/db').truncateAll;

before(async () => {
  db = await integrationEnv('isolation');
  if (!db) return;
  prisma = (await import('../../src/lib/prisma')).prisma;
  truncateAll = (await import('../helpers/db')).truncateAll;
});
beforeEach(async () => { if (db) await truncateAll(prisma); });
after(async () => { if (db) { await prisma.$disconnect(); await db.drop(); } });

const WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

// walletAddress is no longer unique alone (#46); identityKey is the unique
// login identity. Each test asserts truncation isolates it from the last.
for (const name of ['first insert of a unique identity', 'same identity again: truncation isolates tests']) {
  test(name, { skip: skipReason() }, async () => {
    await prisma.user.create({ data: { walletAddress: WALLET, identityKey: WALLET } });
    assert.equal(await prisma.user.count(), 1);
  });
}
