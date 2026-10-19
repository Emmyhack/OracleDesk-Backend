import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Keypair, Operation, StrKey, TransactionBuilder, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';
import { contractEventsField, metaV3, metaV4, transferEvent } from './helpers/sac-meta';

setupTestEnv();

const PRICE = 5_000_000n;

async function load() {
  const verification = await import('../src/services/payment-verification.service');
  const { CONTRACTS, PAYMENTS_RECIPIENT } = await import('../src/config/contracts');
  const { config } = await import('../src/config');
  return { verification, CONTRACTS, PAYMENTS_RECIPIENT, config };
}

interface EnvelopeOpts {
  passphrase: string;
  contract: string;
  fn?: string;
  from: string;
  to: string;
  amount: bigint;
  source?: string;
}

/** A real, signed-shape Soroban transaction envelope invoking `fn` on `contract`. */
function transferEnvelope(opts: EnvelopeOpts) {
  const source = new Account(opts.source ?? opts.from, '1');
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

/** A transaction that is not a direct token transfer (router-style call). */
function routerEnvelope(opts: { passphrase: string; source: string; contract: string }) {
  const tx = new TransactionBuilder(new Account(opts.source, '1'), {
    fee: '100',
    networkPassphrase: opts.passphrase,
  })
    .addOperation(Operation.invokeContractFunction({ contract: opts.contract, function: 'route', args: [] }))
    .setTimeout(30)
    .build();
  return tx.toEnvelope();
}

/** Two direct transfers in one transaction. */
function twoOpEnvelope(opts: { passphrase: string; contract: string; source: string; to: string; amounts: bigint[] }) {
  let builder = new TransactionBuilder(new Account(opts.source, '1'), {
    fee: '100',
    networkPassphrase: opts.passphrase,
  });
  for (const amount of opts.amounts) {
    builder = builder.addOperation(
      Operation.invokeContractFunction({
        contract: opts.contract,
        function: 'transfer',
        args: [
          new Address(opts.source).toScVal(),
          new Address(opts.to).toScVal(),
          nativeToScVal(amount, { type: 'i128' }),
        ],
      }),
    );
  }
  return builder.setTimeout(30).build().toEnvelope();
}

function eventsFor(opts: EnvelopeOpts, extra: Parameters<typeof transferEvent>[0][] = []) {
  return [
    transferEvent({ contract: opts.contract, from: opts.from, to: opts.to, amount: opts.amount }),
    ...extra.map((e) => transferEvent(e)),
  ];
}

type ReaderOpts = {
  status: rpc.Api.GetTransactionStatus;
  envelope?: xdr.TransactionEnvelope;
  events?: xdr.ContractEvent[] | xdr.ContractEvent[][];
  resultMeta?: xdr.TransactionMeta | null;
  /** Omit both meta and events entirely (old/broken RPC). */
  noMeta?: boolean;
};

function reader(opts: ReaderOpts) {
  return {
    async getTransaction(hash: string) {
      const base: any = { status: opts.status, txHash: hash, ledger: 42, createdAt: 1700000000 };
      if (opts.envelope) base.envelopeXdr = opts.envelope;
      if (!opts.noMeta) {
        if (Array.isArray(opts.events) && opts.events.length > 0 && Array.isArray(opts.events[0])) {
          base.resultMetaXdr = metaV4(opts.events as xdr.ContractEvent[][]);
        } else {
          base.resultMetaXdr = opts.resultMeta === undefined ? metaV3((opts.events as xdr.ContractEvent[]) ?? []) : opts.resultMeta;
        }
      }
      return base;
    },
  };
}

const HASH = 'ab'.repeat(32);
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code ?? e.message);

test('payment verification: success and every failure mode', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const passphrase = config.STELLAR_NETWORK_PASSPHRASE;
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const env = (o: Partial<EnvelopeOpts> = {}) =>
    transferEnvelope({ passphrase, contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE, ...o });
  const run = async (r: ReturnType<typeof reader>, e = expected) => {
    const prev = verification.setTransactionReader(r);
    try { return await code(verification.verifyUsdcTransfer(e)); } finally { verification.setTransactionReader(prev); }
  };
  const S = rpc.Api.GetTransactionStatus;
  const okReader = (o: Partial<EnvelopeOpts> = {}) => {
    const options = { passphrase, contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE, ...o };
    return reader({ status: S.SUCCESS, envelope: env(o), events: eventsFor(options) });
  };

  assert.equal(await run(okReader()), 'ok');
  assert.equal(await run(okReader({ amount: PRICE * 10n })), 'ok');
  assert.equal(await run(okReader({ to: Keypair.random().publicKey() })), 'PAYMENT_WRONG_RECIPIENT');
  assert.equal(await run(okReader({ contract: StrKey.encodeContract(Buffer.alloc(32, 7)) })), 'PAYMENT_WRONG_TOKEN');
  // A `mint` event on the token contract is not a transfer.
  const mintReader = reader({
    status: S.SUCCESS,
    envelope: env({ fn: 'mint' }),
    events: [transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE, name: 'mint' })],
  });
  assert.equal(await run(mintReader), 'PAYMENT_WRONG_TOKEN');
  assert.equal(await run(okReader({ amount: PRICE - 1n })), 'PAYMENT_INSUFFICIENT');
  assert.equal(await run(okReader({ from: Keypair.random().publicKey() })), 'PAYMENT_WRONG_SENDER');
  assert.equal(await run(reader({ status: S.FAILED, envelope: env(), events: eventsFor({ passphrase, contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE }) })), 'PAYMENT_FAILED');
  assert.equal(await run(reader({ status: S.NOT_FOUND })), 'PAYMENT_NOT_FOUND');
  assert.equal(await run(okReader(), { ...expected, txHash: '0xnot-a-stellar-hash' }), 'VALIDATION_ERROR');
});

test('payment verification unwraps a fee-bump envelope (#38)', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const passphrase = config.STELLAR_NETWORK_PASSPHRASE;
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const source = new Account(user, '1');
  const inner = new TransactionBuilder(source, { fee: '100', networkPassphrase: passphrase })
    .addOperation(Operation.invokeContractFunction({
      contract: CONTRACTS.usdc,
      function: 'transfer',
      args: [
        new Address(user).toScVal(),
        new Address(PAYMENTS_RECIPIENT).toScVal(),
        nativeToScVal(PRICE, { type: 'i128' }),
      ],
    }))
    .setTimeout(30)
    .build();
  const payer = Keypair.random();
  const outer = TransactionBuilder.buildFeeBumpTransaction(payer, '200', inner, passphrase);
  outer.sign(payer);
  const prev = verification.setTransactionReader(reader({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    envelope: outer.toEnvelope(),
    events: [transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE })],
  }));
  try {
    const result = await verification.verifyUsdcTransfer(expected);
    assert.equal(result.from, user);
    assert.equal(result.amount, PRICE);
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('verifies a C… smart-wallet transfer', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const wallet = StrKey.encodeContract(Buffer.alloc(32, 9));
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: wallet, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const envelope = transferEnvelope({
    passphrase: config.STELLAR_NETWORK_PASSPHRASE,
    contract: CONTRACTS.usdc,
    from: wallet,
    to: PAYMENTS_RECIPIENT,
    amount: PRICE,
    source: Keypair.random().publicKey(),
  });
  const prev = verification.setTransactionReader(reader({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    envelope,
    events: [transferEvent({ contract: CONTRACTS.usdc, from: wallet, to: PAYMENTS_RECIPIENT, amount: PRICE })],
  }));
  try {
    const result = await verification.verifyUsdcTransfer(expected);
    assert.equal(result.from, wallet);
    assert.equal(result.amount, PRICE);
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('verifies a sub-invocation transfer through a router', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const router = StrKey.encodeContract(Buffer.alloc(32, 5));
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const prev = verification.setTransactionReader(reader({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    envelope: routerEnvelope({ passphrase: config.STELLAR_NETWORK_PASSPHRASE, source: user, contract: router }),
    events: [transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE })],
  }));
  try {
    const result = await verification.verifyUsdcTransfer(expected);
    assert.equal(result.amount, PRICE);
    assert.equal(result.transfers.length, 1);
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('verifies a multi-operation transaction and sums qualifying transfers', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const envelope = twoOpEnvelope({
    passphrase: config.STELLAR_NETWORK_PASSPHRASE,
    contract: CONTRACTS.usdc,
    source: user,
    to: PAYMENTS_RECIPIENT,
    amounts: [PRICE / 2n, PRICE / 2n],
  });
  const prev = verification.setTransactionReader(reader({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    envelope,
    events: [
      [transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE / 2n })],
      [transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE / 2n })],
    ],
  }));
  try {
    const result = await verification.verifyUsdcTransfer(expected);
    assert.equal(result.amount, PRICE);
    assert.equal(result.transfers.length, 2);
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('nets same-transaction refunds and rejects when net is insufficient', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const envelope = transferEnvelope({
    passphrase: config.STELLAR_NETWORK_PASSPHRASE,
    contract: CONTRACTS.usdc,
    from: user,
    to: PAYMENTS_RECIPIENT,
    amount: PRICE,
  });
  const prev = verification.setTransactionReader(reader({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    envelope,
    events: [
      transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE }),
      transferEvent({ contract: CONTRACTS.usdc, from: PAYMENTS_RECIPIENT, to: user, amount: 1n }),
    ],
  }));
  try {
    assert.equal(await code(verification.verifyUsdcTransfer(expected)), 'PAYMENT_INSUFFICIENT');
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('decodes CAP-67 map data with to_muxed_id', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const envelope = transferEnvelope({
    passphrase: config.STELLAR_NETWORK_PASSPHRASE,
    contract: CONTRACTS.usdc,
    from: user,
    to: PAYMENTS_RECIPIENT,
    amount: PRICE,
  });
  const prev = verification.setTransactionReader(reader({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    envelope,
    events: [transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE, toMuxedId: '7' })],
  }));
  try {
    const result = await verification.verifyUsdcTransfer(expected);
    assert.equal(result.toMuxedId, '7');
    assert.equal(result.amount, PRICE);
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('SUCCESS without meta fails closed with CHAIN_READ_INCOMPLETE', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const envelope = transferEnvelope({
    passphrase: config.STELLAR_NETWORK_PASSPHRASE,
    contract: CONTRACTS.usdc,
    from: user,
    to: PAYMENTS_RECIPIENT,
    amount: PRICE,
  });
  const prev = verification.setTransactionReader(reader({ status: rpc.Api.GetTransactionStatus.SUCCESS, envelope, noMeta: true }));
  try {
    assert.equal(await code(verification.verifyUsdcTransfer(expected)), 'CHAIN_READ_INCOMPLETE');
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('prefers the RPC contractEventsXdr field over resultMetaXdr', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const user = Keypair.random().publicKey();
  const expected = { txHash: HASH, token: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, minAmount: PRICE };
  const envelope = transferEnvelope({
    passphrase: config.STELLAR_NETWORK_PASSPHRASE,
    contract: CONTRACTS.usdc,
    from: user,
    to: PAYMENTS_RECIPIENT,
    amount: PRICE,
  });
  const prev = verification.setTransactionReader({
    async getTransaction(hash: string) {
      return {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: hash,
        ledger: 42,
        envelopeXdr: envelope,
        resultMetaXdr: metaV3([]),
        events: {
          transactionEventsXdr: [],
          contractEventsXdr: contractEventsField([
            [transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE })],
          ]),
        },
      } as any;
    },
  });
  try {
    const result = await verification.verifyUsdcTransfer(expected);
    assert.equal(result.amount, PRICE);
    assert.equal(result.transfers[0].opIndex, 0);
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
  (prisma.subscription.findFirst as any) = async ({ where }: any) =>
    subs.find((s) => (where.txHash === undefined || s.txHash === where.txHash)) ?? null;
  (prisma.spendingAllowance.findUnique as any) = async () => null;
  (prisma.$transaction as any) = async (fn: any) => fn({
    $queryRaw: async () => [{ locked: true }],
    paymentEvent: {
      findUnique: async ({ where }: any) => used.get(where.txHash) ?? null,
      create: async ({ data }: any) => { used.set(data.txHash, { userId: data.userId }); return data; },
    },
    subscription: {
      findFirst: async ({ where }: any) => subs.find((s) => (where.txHash === undefined || s.txHash === where.txHash)) ?? null,
      create: async ({ data }: any) => { const s = { id: `sub-${subs.length}`, ...data }; subs.push(s); return s; },
    },
    spendingAllowance: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
  });

  const env = transferEnvelope({ passphrase: config.STELLAR_NETWORK_PASSPHRASE, contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE });
  const prev = verification.setTransactionReader(reader({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    envelope: env,
    events: [transferEvent({ contract: CONTRACTS.usdc, from: user, to: PAYMENTS_RECIPIENT, amount: PRICE })],
  }));
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

test('C… session can claim a daily pass paid from that contract (#47)', async () => {
  const { verification, CONTRACTS, PAYMENTS_RECIPIENT, config } = await load();
  const { prisma } = await import('../src/lib/prisma');
  const { recordPayment } = await import('../src/services/subscription.service');
  const wallet = StrKey.encodeContract(Buffer.alloc(32, 11));
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

  const envelope = transferEnvelope({
    passphrase: config.STELLAR_NETWORK_PASSPHRASE,
    contract: CONTRACTS.usdc,
    from: wallet,
    to: PAYMENTS_RECIPIENT,
    amount: PRICE,
    source: Keypair.random().publicKey(),
  });
  const prev = verification.setTransactionReader(reader({
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    envelope,
    events: [transferEvent({ contract: CONTRACTS.usdc, from: wallet, to: PAYMENTS_RECIPIENT, amount: PRICE })],
  }));
  try {
    const sub = await recordPayment({ userId: 'c1', walletAddress: wallet, type: 'DAILY_PASS', txHash: HASH });
    assert.equal(sub.status, 'ACTIVE');
  } finally {
    verification.setTransactionReader(prev);
  }
});
