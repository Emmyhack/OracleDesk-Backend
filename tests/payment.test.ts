import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Keypair, Operation, TransactionBuilder, nativeToScVal, rpc, StrKey } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const PRICE = 5_000_000n;

async function load() {
  const verification = await import('../src/services/payment-verification.service');
  const { CONTRACTS, PAYMENTS_RECIPIENT } = await import('../src/config/contracts');
  const { config } = await import('../src/config');
  return { verification, CONTRACTS, PAYMENTS_RECIPIENT, config };
}

/** A real, signed-shape Soroban transaction envelope invoking `fn` on `contract`. */
function transferEnvelope(opts: { passphrase: string; contract: string; fn?: string; from: string; to: string; amount: bigint }) {
  const source = new Account(opts.from, '1');
  const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: opts.passphrase })
    .addOperation(Operation.invokeContractFunction({
      contract: opts.contract,
      function: opts.fn ?? 'transfer',
      args: [
        new Address(opts.from).toScVal(),
        new Address(opts.to).toScVal(),
        nativeToScVal(opts.amount, { type: 'i128' }),
      ],
    }))
    .setTimeout(30)
    .build();
  return tx.toEnvelope();
}

function reader(status: rpc.Api.GetTransactionStatus, envelope?: ReturnType<typeof transferEnvelope>) {
  return {
    async getTransaction(hash: string) {
      return { status, txHash: hash, ledger: 42, envelopeXdr: envelope } as any;
    },
  };
}

/** The same transfer, submitted inside a fee-bump envelope (#38). */
function feeBumpedEnvelope(opts: Parameters<typeof transferEnvelope>[0]) {
  const source = new Account(opts.from, '1');
  const inner = new TransactionBuilder(source, { fee: '100', networkPassphrase: opts.passphrase })
    .addOperation(Operation.invokeContractFunction({
      contract: opts.contract,
      function: opts.fn ?? 'transfer',
      args: [
        new Address(opts.from).toScVal(),
        new Address(opts.to).toScVal(),
        nativeToScVal(opts.amount, { type: 'i128' }),
      ],
    }))
    .setTimeout(30)
    .build();
  const payer = Keypair.random();
  const outer = TransactionBuilder.buildFeeBumpTransaction(payer, '200', inner, opts.passphrase);
  outer.sign(payer);
  return outer.toEnvelope();
}

const HASH = 'ab'.repeat(32);
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code ?? e.message);

test('payment verification: success and every failure mode', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const passphrase = config.STELLAR_NETWORK_PASSPHRASE;
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const env = (o: Partial<Parameters<typeof transferEnvelope>[0]> = {}) =>
    transferEnvelope({ passphrase, contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE, ...o });
  const run = async (r: ReturnType<typeof reader>, e = expected) => {
    const prev = verification.setTransactionReader(r);
    try { return await code(verification.verifyUsdcTransfer(e)); } finally { verification.setTransactionReader(prev); }
  };
  const S = rpc.Api.GetTransactionStatus;

  assert.equal(await run(reader(S.SUCCESS, env())), 'ok');
  assert.equal(await run(reader(S.SUCCESS, env({ amount: PRICE * 10n }))), 'ok');
  assert.equal(await run(reader(S.SUCCESS, env({ to: Keypair.random().publicKey() }))), 'PAYMENT_WRONG_RECIPIENT');
  assert.equal(await run(reader(S.SUCCESS, env({ contract: StrKey.encodeContract(Buffer.alloc(32, 7)) }))), 'PAYMENT_WRONG_TOKEN');
  assert.equal(await run(reader(S.SUCCESS, env({ fn: 'mint' }))), 'PAYMENT_WRONG_TOKEN');
  assert.equal(await run(reader(S.SUCCESS, env({ amount: PRICE - 1n }))), 'PAYMENT_INSUFFICIENT');
  assert.equal(await run(reader(S.SUCCESS, env({ from: Keypair.random().publicKey() }))), 'PAYMENT_WRONG_SENDER');
  assert.equal(await run(reader(S.FAILED, env())), 'PAYMENT_FAILED');
  assert.equal(await run(reader(S.NOT_FOUND)), 'PAYMENT_NOT_FOUND');
  assert.equal(await run(reader(S.SUCCESS, env()), { ...expected, txHash: '0xnot-a-stellar-hash' }), 'VALIDATION_ERROR');
});

test('payment verification unwraps a fee-bump envelope (#38)', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const passphrase = config.STELLAR_NETWORK_PASSPHRASE;
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const bumped = feeBumpedEnvelope({ passphrase, contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE });
  const prev = verification.setTransactionReader(reader(rpc.Api.GetTransactionStatus.SUCCESS, bumped as any));
  try {
    const result = await verification.verifyUsdcTransfer(expected);
    assert.equal(result.from, user);
    assert.equal(result.amount, PRICE);
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('recordPayment: grants a pass once per hash and never without verification', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const { prisma } = await import('../src/lib/prisma');
  const { recordPayment } = await import('../src/services/subscription.service');
  const user = Keypair.random().publicKey();
  const used = new Map<string, { userId: string }>();
  const subs: any[] = [];

  (prisma.paymentEvent.findUnique as any) = async ({ where }: any) => used.get(where.txHash) ?? null;
  (prisma.subscription.findFirst as any) = async ({ where }: any) => subs.find((s) => s.txHash === where.txHash) ?? null;
  (prisma.spendingAllowance.findUnique as any) = async () => null;
  (prisma.$transaction as any) = async (fn: any) => fn({
    subscription: { create: async ({ data }: any) => { const s = { id: `sub-${subs.length}`, ...data }; subs.push(s); return s; } },
    paymentEvent: { create: async ({ data }: any) => { used.set(data.txHash, { userId: data.userId }); return data; } },
    spendingAllowance: { updateMany: async () => ({ count: 0 }) },
  });

  const env = transferEnvelope({ passphrase: config.STELLAR_NETWORK_PASSPHRASE, contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE });
  const prev = verification.setTransactionReader(reader(rpc.Api.GetTransactionStatus.SUCCESS, env));
  try {
    const sub = await recordPayment({ userId: 'u1', walletAddress: user, type: 'DAILY_PASS', txHash: HASH });
    assert.equal(sub.status, 'ACTIVE');
    assert.equal(sub.amountPaid, 0.5);

    // Same user, same hash: idempotent, returns the existing pass.
    const again = await recordPayment({ userId: 'u1', walletAddress: user, type: 'DAILY_PASS', txHash: HASH });
    assert.equal(again.id, sub.id);
    assert.equal(subs.length, 1);

    // Another user replaying the hash.
    assert.equal(await code(recordPayment({ userId: 'u2', walletAddress: Keypair.random().publicKey(), type: 'DAILY_PASS', txHash: HASH })), 'PAYMENT_ALREADY_USED');

    // Per-trace goes through x402.
    assert.equal(await code(recordPayment({ userId: 'u1', walletAddress: user, type: 'PER_TRACE', txHash: 'cd'.repeat(32) })), 'USE_X402');
  } finally {
    verification.setTransactionReader(prev);
  }

  // RPC unreachable: no access.
  const prev2 = verification.setTransactionReader({ async getTransaction() { throw new Error('ECONNREFUSED'); } });
  try {
    assert.equal(await code(recordPayment({ userId: 'u3', walletAddress: user, type: 'DAILY_PASS', txHash: 'ef'.repeat(32) })), 'CHAIN_READ_FAILED');
    assert.equal(subs.length, 1);
  } finally {
    verification.setTransactionReader(prev2);
  }
});
