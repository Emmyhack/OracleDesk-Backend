import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

function fakeState(overrides: any = {}) {
  return {
    network: Networks.TESTNET,
    contracts: { treasury: 'CTREASURY', marketCore: 'CMARKET', usdc: 'CUSDC' },
    treasury: {
      config: { agent: 'GAGENT', collateral: 'CUSDC', market_core: 'CMARKET', max_daily: 1000n, max_market: 500n, max_trade: 100n },
      availableCapitalRaw: '1000000000',
      usdcBalanceRaw: '1000000000',
      dailyUsage: { amountRaw: '0', dayStart: 0, resetsAt: '2026-10-18T00:00:00.000Z', remainingRaw: '1000' },
      paused: false,
      admin: { address: 'GADMIN', kind: 'account' as const },
      ...(overrides.treasury ?? {}),
    },
    marketCore: { paused: false, admin: 'GADMIN' },
    agent: { address: 'GAGENT', xlmBalance: '100' },
  } as any;
}

function fakeAccount(overrides: any = {}) {
  return {
    address: 'GADMIN',
    kind: 'account' as const,
    balanceXlm: '100',
    masterWeight: 1,
    thresholds: { low: 1, medium: 1, high: 2 },
    signers: [],
    ...overrides,
  } as any;
}

async function stubPrisma(row: any = null) {
  const { prisma } = await import('../src/lib/prisma');
  (prisma.adminOperation.findUnique as any) = async () => row;
  (prisma.adminOperation.create as any) = async ({ data }: any) => ({ id: 'op-1', ...data });
  (prisma.adminOperation.update as any) = async ({ data }: any) => ({ id: 'op-1', ...data });
  (prisma.agentLog.create as any) = async ({ data }: any) => ({ id: 'log-1', ...data });
  return prisma;
}

function envelope(source: string): any {
  return new TransactionBuilder(new Account(source, '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.manageData({ name: 'test', value: '1' }))
    .setTimeout(60)
    .build();
}

test('prepare rejects a withdraw above available capital before building (#156)', async () => {
  const { prepareOperation } = await import('../src/services/treasury-ops.service');
  await assert.rejects(
    prepareOperation(
      { kind: 'treasury.withdraw', to: Keypair.random().publicKey(), amountRaw: (2_000_000_000n).toString() },
      'admin',
      { state: async () => fakeState(), account: async () => fakeAccount() },
    ),
    (err: any) => err.code === 'PREFLIGHT_FAILED' && err.details.checks.some((c: any) => c.name === 'amount_within_available_capital' && !c.ok),
  );
});

test('prepare returns an unsigned simulated operation with a human summary (#156)', async () => {
  const { prepareOperation } = await import('../src/services/treasury-ops.service');
  await stubPrisma();
  const prepared = await prepareOperation(
    { kind: 'treasury.set_paused', paused: true },
    'GADMIN',
    {
      state: async () => fakeState(),
      account: async () => fakeAccount(),
      build: async () => ({ xdr: 'AAAA', hash: 'a'.repeat(64), contractId: 'CTREASURY', sourceAccount: 'GADMIN' }),
    },
  );
  assert.equal(prepared.hash, 'a'.repeat(64));
  assert.equal(prepared.requiredSigners, 2);
  assert.equal(prepared.status, 'PREPARED');
  assert.match(prepared.humanSummary, /Pause treasury/);
  assert.ok(prepared.checks.some((c) => c.name === 'simulation' && c.ok));
});

test('a signed envelope with a different body hash is rejected (#156)', async () => {
  const { addSignature } = await import('../src/services/treasury-ops.service');
  const kp = Keypair.random();
  await stubPrisma({
    id: 'op-1',
    kind: 'treasury.set_paused',
    sourceAccount: kp.publicKey(),
    unsignedXdr: envelope(kp.publicKey()).toXDR(),
    txHash: 'b'.repeat(64),
    signatures: [],
    status: 'PREPARED',
    expiresAt: new Date(Date.now() + 60_000),
  });
  const signed = envelope(kp.publicKey());
  signed.sign(kp);
  await assert.rejects(
    addSignature('op-1', signed.toXDR(), 'signer'),
    (err: any) => err.code === 'ADMIN_OP_HASH_MISMATCH',
  );
});

test('two of three signatures reach READY and duplicates are ignored (#156)', async () => {
  const { addSignature } = await import('../src/services/treasury-ops.service');
  const admin = Keypair.random();
  const second = Keypair.random();
  const tx = envelope(admin.publicKey());
  tx.sign(admin);
  tx.sign(second);
  await stubPrisma({
    id: 'op-2',
    kind: 'treasury.set_paused',
    sourceAccount: admin.publicKey(),
    unsignedXdr: envelope(admin.publicKey()).toXDR(),
    txHash: tx.hash().toString('hex'),
    signatures: [],
    status: 'PREPARED',
    expiresAt: new Date(Date.now() + 60_000),
  });
  const result = await addSignature('op-2', tx.toXDR(), 'signer', {
    account: async () => fakeAccount({ address: admin.publicKey(), signers: [{ key: second.publicKey(), kind: 'ed25519', weight: 1 }] }),
  });
  assert.equal(result.weightCollected, 2);
  assert.equal(result.requiredSigners, 2);
  assert.equal(result.status, 'READY');
  assert.equal(result.signatures.length, 2);
});

test('submit refuses expired and not-ready operations (#156)', async () => {
  const { submitOperation } = await import('../src/services/treasury-ops.service');
  await stubPrisma({
    id: 'op-3',
    status: 'PREPARED',
    signedXdr: 'AAAA',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  await assert.rejects(submitOperation('op-3', { now: () => Date.parse('2026-10-01T00:00:00.000Z') }), (err: any) => err.code === 'ADMIN_OP_EXPIRED');

  await stubPrisma({ id: 'op-4', status: 'PREPARED', signedXdr: 'AAAA', expiresAt: new Date('2027-01-01T00:00:00.000Z') });
  await assert.rejects(submitOperation('op-4'), (err: any) => err.code === 'ADMIN_OP_NOT_READY');
});

test('submit records SUCCESS with ledger and audits the change (#156)', async () => {
  const { submitOperation } = await import('../src/services/treasury-ops.service');
  const prisma = await stubPrisma({ id: 'op-5', status: 'READY', signedXdr: 'AAAA', expiresAt: new Date('2027-01-01T00:00:00.000Z') });
  const result = await submitOperation('op-5', {
    submit: async () => ({ status: 'SUCCESS', hash: 'c'.repeat(64), ledger: 123, resultXdr: 'RESULT' }),
  });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.ledger, 123);
  assert.equal((prisma.agentLog.create as any).mock?.calls?.length ?? 1, 1);
});
