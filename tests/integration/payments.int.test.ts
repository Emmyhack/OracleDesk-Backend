import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Keypair, Operation, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { integrationEnv, skipReason } from './setup';

let db: Awaited<ReturnType<typeof integrationEnv>>;
let prisma: import('@prisma/client').PrismaClient;
let verification: typeof import('../../src/services/payment-verification.service');
let recordPayment: typeof import('../../src/services/subscription.service').recordPayment;
let truncateAll: typeof import('../helpers/db').truncateAll;
let makeUser: typeof import('../helpers/factories').makeUser;
let usdc: string;
let recipient: string;
let passphrase: string;

before(async () => {
  db = await integrationEnv('payments');
  if (!db) return;
  prisma = (await import('../../src/lib/prisma')).prisma;
  verification = await import('../../src/services/payment-verification.service');
  ({ recordPayment } = await import('../../src/services/subscription.service'));
  ({ truncateAll } = await import('../helpers/db'));
  ({ makeUser } = await import('../helpers/factories'));
  const contracts = await import('../../src/config/contracts');
  usdc = contracts.CONTRACTS.usdc;
  recipient = contracts.PAYMENTS_RECIPIENT;
  passphrase = (await import('../../src/config')).config.STELLAR_NETWORK_PASSPHRASE;
});
beforeEach(async () => { if (db) await truncateAll(prisma); });
after(async () => { if (db) { await prisma.$disconnect(); await db.drop(); } });

const PRICE = 5_000_000n;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code ?? e.message);

/** A successful USDC transfer of the pass price from `from`, served by a fake reader. */
function transferTx(from: string) {
  return new TransactionBuilder(new Account(from, '1'), { fee: '100', networkPassphrase: passphrase })
    .addOperation(Operation.invokeContractFunction({
      contract: usdc,
      function: 'transfer',
      args: [new Address(from).toScVal(), new Address(recipient).toScVal(), nativeToScVal(PRICE, { type: 'i128' })],
    }))
    .setTimeout(30)
    .build();
}

function useTransfer(from: string) {
  const tx = transferTx(from);
  return verification.setTransactionReader({
    async getTransaction(hash: string) {
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: hash, ledger: 42, envelopeXdr: tx.toEnvelope() } as any;
    },
  });
}

/** Like useTransfer, but counts getTransaction calls so races can be asserted. */
function countingTransfer(from: string) {
  const tx = transferTx(from);
  const calls = { getTransaction: 0 };
  return {
    calls,
    reader: {
      async getTransaction(hash: string) {
        calls.getTransaction++;
        // Widen the race window so a non-serialized implementation would show it.
        await new Promise((r) => setTimeout(r, 25));
        return { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: hash, ledger: 42, envelopeXdr: tx.toEnvelope() } as any;
      },
    },
  };
}

test('grants pass once (idempotent re-submit)', { skip: skipReason() }, async () => {
  const user = await makeUser(prisma);
  const prev = useTransfer(user.walletAddress);
  try {
    const hash = 'ab'.repeat(32);
    const args = { userId: user.id, walletAddress: user.walletAddress, type: 'DAILY_PASS' as const, txHash: hash };
    const first = await recordPayment(args);
    const again = await recordPayment(args);
    assert.equal(again.id, first.id);
    assert.equal(await prisma.subscription.count(), 1);
    assert.equal(await prisma.paymentEvent.count(), 1);
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('rejects hash reuse by another user', { skip: skipReason() }, async () => {
  const owner = await makeUser(prisma);
  const other = await makeUser(prisma);
  const hash = 'cd'.repeat(32);
  let prev = useTransfer(owner.walletAddress);
  try {
    await recordPayment({ userId: owner.id, walletAddress: owner.walletAddress, type: 'DAILY_PASS', txHash: hash });
  } finally {
    verification.setTransactionReader(prev);
  }
  prev = useTransfer(other.walletAddress);
  try {
    assert.equal(
      await code(recordPayment({ userId: other.id, walletAddress: other.walletAddress, type: 'DAILY_PASS', txHash: hash })),
      'PAYMENT_ALREADY_USED',
    );
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('concurrent double claim by the same user yields one pass and one RPC call (#59)', { skip: skipReason() }, async () => {
  const user = await makeUser(prisma);
  const { reader, calls } = countingTransfer(user.walletAddress);
  const prev = verification.setTransactionReader(reader);
  try {
    const hash = 'ef'.repeat(32);
    const claim = () => code(recordPayment({ userId: user.id, walletAddress: user.walletAddress, type: 'DAILY_PASS' as const, txHash: hash }));
    const results = await Promise.all(Array.from({ length: 8 }, claim));
    assert.equal(await prisma.subscription.count(), 1);
    assert.equal(await prisma.paymentEvent.count(), 1);
    // The owner always gets success: the winner and every idempotent racer.
    assert.deepEqual(results, Array(8).fill('ok'));
    assert.equal(calls.getTransaction, 1, 'verification runs once per hash');
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('concurrent claim by another user is always 409 and never verifies twice (#59)', { skip: skipReason() }, async () => {
  const owner = await makeUser(prisma);
  const other = await makeUser(prisma);
  const { reader, calls } = countingTransfer(owner.walletAddress);
  const prev = verification.setTransactionReader(reader);
  try {
    const hash = 'a1'.repeat(32);
    const claim = (u: typeof owner) => code(recordPayment({ userId: u.id, walletAddress: u.walletAddress, type: 'DAILY_PASS' as const, txHash: hash }));
    const results = await Promise.all([claim(owner), claim(other), claim(owner), claim(other), claim(other)]);
    assert.equal(await prisma.subscription.count(), 1);
    assert.equal(await prisma.paymentEvent.count(), 1);
    assert.equal(results[0], 'ok');
    assert.equal(results[2], 'ok');
    for (const r of [results[1], results[3], results[4]]) assert.equal(r, 'PAYMENT_ALREADY_USED');
    assert.equal(calls.getTransaction, 1, 'racers reuse the first result');
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('an over-allowance payment is granted and flagged, never refused or dropped (#53)', { skip: skipReason() }, async () => {
  const user = await makeUser(prisma);
  // 1 base unit of daily and per-trace approval: the pass price overflows it.
  await prisma.spendingAllowance.create({
    data: {
      userId: user.id,
      dailyLimit: 0.0000001,
      perTraceLimit: 0.0000001,
      dailyLimitRaw: '1',
      perTraceLimitRaw: '1',
      windowStartedAt: new Date(),
    },
  });
  const { reader } = countingTransfer(user.walletAddress);
  const prev = verification.setTransactionReader(reader);
  try {
    const hash = 'b2'.repeat(32);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => code(recordPayment({ userId: user.id, walletAddress: user.walletAddress, type: 'DAILY_PASS' as const, txHash: hash }))),
    );
    assert.deepEqual(results, Array(4).fill('ok'));
    assert.equal(await prisma.subscription.count(), 1);
    assert.equal(await prisma.subscription.count({ where: { status: 'ACTIVE' } }), 1);
    const event = await prisma.paymentEvent.findFirstOrThrow();
    assert.equal(event.allowanceOverage, true);
    assert.equal(event.allowanceOverageRaw?.toString(), (PRICE - 1n).toString());
    const allowance = await prisma.spendingAllowance.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(allowance.overageRaw.toString(), (PRICE - 1n).toString());
  } finally {
    verification.setTransactionReader(prev);
  }
});

test.todo('rolls back on mid-transaction failure (needs a fault-injection hook in recordPayment)');
