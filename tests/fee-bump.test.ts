import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Keypair, Networks, Operation, SorobanDataBuilder, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const PASSPHRASE = Networks.TESTNET;

function sorobanTx(opts: { resourceFee: number; inclusionPerOp: number; ops?: number; source?: Keypair }): {
  tx: ReturnType<TransactionBuilder['build']>;
  source: Keypair;
} {
  const source = opts.source ?? Keypair.random();
  const ops = opts.ops ?? 1;
  const fee = String(opts.resourceFee + opts.inclusionPerOp * ops);
  const account = new Account(source.publicKey(), '100');
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  let builder = new TransactionBuilder(account, { fee, networkPassphrase: PASSPHRASE });
  for (let i = 0; i < ops; i++) {
    builder = builder.addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: 'noop',
            args: [],
          }),
        ),
        auth: [],
      }),
    );
  }
  const tx = builder.setSorobanData(new SorobanDataBuilder().setResourceFee(opts.resourceFee).build()).setTimeout(0).build();
  return { tx, source };
}

test('planBump computes outerFee = resourceFee + inclusion × (ops + 1)', async () => {
  const { planBump } = await import('../src/services/stellar/fee-bump');
  const { tx } = sorobanTx({ resourceFee: 5000, inclusionPerOp: 200 });
  // prev × multiplier = 100 × 2 = 200; innerInclusion + 1 = 201 wins.
  const plan = planBump(tx, 100n, { multiplier: 2, maxStroops: 10_000_000n });
  assert.equal(plan.resourceFee, 5000n);
  assert.equal(plan.inclusionPerOp, 201n);
  assert.equal(plan.outerFee, 5000n + 201n * 2n);
});

test('buildFeeBump fee matches planBump and preserves the inner transaction', async () => {
  const { planBump, buildFeeBump } = await import('../src/services/stellar/fee-bump');
  const { tx, source } = sorobanTx({ resourceFee: 5000, inclusionPerOp: 200 });
  const innerHash = tx.hash().toString('hex');
  const plan = planBump(tx, 100n, { multiplier: 3, maxStroops: 10_000_000n });
  const payer = Keypair.random();
  const outer = buildFeeBump(tx, plan, payer.publicKey(), PASSPHRASE);

  assert.equal(BigInt(outer.fee), plan.outerFee);
  assert.equal(outer.hash().toString('hex') === innerHash, false, 'outer hash differs from inner');
  // The wrapped inner is byte-for-byte the original: same hash, same signatures.
  const wrappedInner = outer.innerTransaction;
  assert.equal(wrappedInner.hash().toString('hex'), innerHash);
  assert.deepEqual(wrappedInner.signatures.map((s) => s.toXDR('base64')), tx.signatures.map((s) => s.toXDR('base64')));
  void source;
});

test('signFeeBump signs only the outer transaction', async () => {
  const { planBump, buildFeeBump, signFeeBump } = await import('../src/services/stellar/fee-bump');
  const { tx } = sorobanTx({ resourceFee: 100, inclusionPerOp: 10 });
  const payer = Keypair.random();
  const plan = planBump(tx, 10n, { multiplier: 2, maxStroops: 10_000_000n });
  const outer = buildFeeBump(tx, plan, payer.publicKey(), PASSPHRASE);
  const signed = await signFeeBump(outer, { keypair: payer }, PASSPHRASE);
  assert.equal(signed.signatures.length, 1);
  assert.equal(signed.innerTransaction.signatures.length, tx.signatures.length);
});

test('planBump raises FEE_BUMP_CAP_EXCEEDED above the cap', async () => {
  const { planBump, FeeBumpCapExceeded } = await import('../src/services/stellar/fee-bump');
  const { tx } = sorobanTx({ resourceFee: 5000, inclusionPerOp: 200 });
  assert.throws(() => planBump(tx, 1_000_000n, { multiplier: 10, maxStroops: 1000n }), FeeBumpCapExceeded);
});

test('shouldBump waits for the threshold and stops at maxTime and max attempts', async () => {
  const { shouldBump } = await import('../src/services/stellar/outbox');
  const opts = { afterLedgers: 3, maxAttempts: 3 };
  const base = { status: 'SUBMITTED', submitLedger: 100, maxTime: null, bumpAttempts: 0 };
  assert.equal(shouldBump(base, 102, 0, opts), false, 'too soon');
  assert.equal(shouldBump(base, 103, 0, opts), true);
  assert.equal(shouldBump({ ...base, bumpAttempts: 3 }, 200, 0, opts), false, 'attempt cap');
  assert.equal(shouldBump({ ...base, maxTime: 1_000_000n }, 200, 999_999, opts), false, 'near maxTime');
  assert.equal(shouldBump({ ...base, status: 'SUCCESS' }, 200, 0, opts), false, 'already resolved');
});
