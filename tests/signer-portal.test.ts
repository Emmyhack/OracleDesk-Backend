import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Account, Address, Keypair, Operation, TransactionBuilder, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const MARKET_ID = '11111111-1111-4111-8111-111111111111';
const ON_CHAIN = 5n;
const [s1, s2, s3, outsider] = [Keypair.random(), Keypair.random(), Keypair.random(), Keypair.random()];
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code ?? e.message);
const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: any) => e.statusCode ?? 500);

async function world(opts: { threshold?: number; signers?: string[]; state?: string } = {}) {
  const { prisma } = await import('../src/lib/prisma');
  const { config } = await import('../src/config');
  const { CONTRACTS } = await import('../src/config/contracts');
  const { resolutionHash } = await import('../src/lib/resolution-spec');
  const { sha256Hex } = await import('../src/utils/hash.util');
  const portal = await import('../src/services/signer-portal.service');

  const spec = {
    kind: 'signers' as const,
    signers: opts.signers ?? [s1.publicKey(), s2.publicKey(), s3.publicKey()],
    threshold: opts.threshold ?? 2,
    disputeWindow: 3600,
  };
  const hash = resolutionHash(spec).toString('hex');
  const questionDoc = Buffer.from(JSON.stringify({ version: 1, question: 'Will it?', closeTime: 1, resolutionSource: 'FRED:DGS10', resolutionHash: hash }));
  const market: any = {
    id: MARKET_ID,
    question: 'Will it?',
    status: 'ACTIVE',
    onChainMarketId: ON_CHAIN,
    resolutionSpec: spec,
    resolutionHash: hash,
    expiryTimestamp: new Date(Date.now() - 3600_000),
    resolutionOracle: 'FRED:DGS10',
    metaUri: 'ipfs://bafyquestion',
    questionHash: sha256Hex(questionDoc),
  };

  const rows: any[] = [];
  let seq = 0;
  const matches = (r: any, where: any) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in (v as any)) return (v as any).in.includes(r[k]);
      return r[k] === v;
    });
  (prisma.market.findUnique as any) = async ({ where }: any) => (where.id === market.id ? market : null);
  (prisma.signerAttestation.findMany as any) = async ({ where }: any) => rows.filter((r) => matches(r, where));
  (prisma.signerAttestation.findFirst as any) = async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null;
  (prisma.signerAttestation.upsert as any) = async ({ where, create, update }: any) => {
    const k = where.onChainMarketId_signer_outcome;
    const existing = rows.find((r) => r.onChainMarketId === k.onChainMarketId && r.signer === k.signer && r.outcome === k.outcome);
    if (existing) return Object.assign(existing, update);
    const row = { id: `att-${++seq}`, updatedAt: new Date(), ...create };
    rows.push(row);
    return row;
  };
  (prisma.signerAttestation.update as any) = async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data, { updatedAt: new Date() });
  (prisma.signerAttestation.updateMany as any) = async ({ where, data }: any) => {
    const hit = rows.filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  };
  let proposalEvent: any = null;
  (prisma.chainEvent.findFirst as any) = async () => proposalEvent;
  (prisma.reasoningTrace.findMany as any) = async () => [
    { id: 'tr1', agentType: 'MARKET_MAKER', ipfsCid: 'bafytrace', traceHash: 'ab'.repeat(32), onChainTraceId: 3n, verified: true, createdAt: new Date() },
  ];

  // A real, unsigned Soroban-shaped transaction with the signer as source.
  const state = { simError: undefined as string | undefined, extraSigners: [] as string[], builds: 0, sequence: 1000 };
  const clientFor = (wallet: string) => ({
    attest: async ({ market_id, outcome }: any) => {
      state.builds++;
      const built = new TransactionBuilder(new Account(wallet, String(state.sequence)), {
        fee: '100',
        networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.invokeContractFunction({
          contract: CONTRACTS.resolver,
          function: 'attest',
          args: [nativeToScVal(market_id, { type: 'u64' }), new Address(wallet).toScVal(), xdr.ScVal.scvSymbol(outcome.tag)],
        }))
        .setTimeout(300)
        .build();
      return {
        simulation: state.simError ? { error: state.simError } : {},
        needsNonInvokerSigningBy: () => state.extraSigners,
        built,
        toXDR: () => built.toXDR(),
      };
    },
  });

  const sent: any[] = [];
  const rpcState = { sendStatus: 'PENDING', txStatus: 'SUCCESS', ledger: 321, errorResult: undefined as unknown, resultXdr: undefined as unknown };
  const rpc = {
    async sendTransaction(tx: any) {
      sent.push(tx);
      return { status: rpcState.sendStatus, errorResult: rpcState.errorResult };
    },
    async getTransaction(_hash: string) {
      return { status: rpcState.txStatus, ledger: rpcState.ledger, resultXdr: rpcState.resultXdr };
    },
  };

  let clock = new Date();
  const restore = portal.setSignerPortalDeps({
    clientFor: clientFor as any,
    onChainResolutionHash: async () => hash,
    resolverState: async () => opts.state ?? 'SignersPending',
    fetchQuestion: async () => questionDoc,
    rpc: rpc as any,
    now: () => clock,
    confirmTimeoutMs: 200,
    pollMs: 10,
  });
  return {
    portal, prisma, config, spec, hash, market, rows, state, sent, rpcState, restore,
    setProposal: (e: any) => { proposalEvent = e; },
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    sign(xdrText: string, ...keys: Keypair[]) {
      const tx = TransactionBuilder.fromXDR(xdrText, config.STELLAR_NETWORK_PASSPHRASE);
      for (const k of keys) tx.sign(k);
      return tx.toXDR();
    },
  };
}

test('the committed spec, not the environment, decides who is a signer', async () => {
  const w = await world();
  try {
    // Env drift: the signer was removed from RESOLUTION_SIGNERS after the market was created.
    (w.config as any).RESOLUTION_SIGNERS = [outsider.publicKey()];
    (w.config as any).RESOLUTION_THRESHOLD = 1;
    const ctx = await w.portal.assertMarketSigner(MARKET_ID, s1.publicKey());
    assert.deepEqual(ctx.spec.signers, w.spec.signers);
    assert.equal(ctx.onChainMarketId, ON_CHAIN);
    // ...and a wallet that is in the env but not in the spec is not a signer.
    assert.equal(await code(w.portal.assertMarketSigner(MARKET_ID, outsider.publicKey())), 'NOT_A_SIGNER');
  } finally {
    (w.config as any).RESOLUTION_SIGNERS = [];
    (w.config as any).RESOLUTION_THRESHOLD = 1;
    w.restore();
  }
});

test('a spec that does not match the on-chain resolution_hash is SPEC_MISMATCH', async () => {
  const w = await world();
  try {
    w.portal.setSignerPortalDeps({ onChainResolutionHash: async () => 'ff'.repeat(32) });
    assert.equal(await code(w.portal.committedSignerSpec(MARKET_ID)), 'SPEC_MISMATCH');
    assert.equal(await statusOf(w.portal.committedSignerSpec(MARKET_ID)), 409);
  } finally {
    w.restore();
  }
});

test('a stored spec that does not re-hash to Market.resolutionHash is SPEC_MISMATCH', async () => {
  const w = await world();
  try {
    w.market.resolutionSpec = { ...w.spec, signers: [...w.spec.signers, outsider.publicKey()] };
    assert.equal(await code(w.portal.committedSignerSpec(MARKET_ID)), 'SPEC_MISMATCH');
  } finally {
    w.restore();
  }
});

test('unknown, off-chain and price-mode markets are reported precisely', async () => {
  const w = await world();
  try {
    assert.equal(await code(w.portal.committedSignerSpec('22222222-2222-4222-8222-222222222222')), 'MARKET_NOT_FOUND');
    const saved = w.market.onChainMarketId;
    w.market.onChainMarketId = null;
    assert.equal(await code(w.portal.committedSignerSpec(MARKET_ID)), 'MARKET_NOT_ON_CHAIN');
    w.market.onChainMarketId = saved;
    w.market.resolutionSpec = null;
    assert.equal(await code(w.portal.committedSignerSpec(MARKET_ID)), 'SPEC_NOT_COMMITTED');
  } finally {
    w.restore();
  }
});

test('a non-signer gets 403 NOT_A_SIGNER on every per-market operation', async () => {
  const w = await world();
  try {
    const who = outsider.publicKey();
    assert.equal(await code(w.portal.getEvidence(MARKET_ID, who)), 'NOT_A_SIGNER');
    assert.equal(await code(w.portal.prepareAttestation(MARKET_ID, who, 'YES')), 'NOT_A_SIGNER');
    assert.equal(await code(w.portal.submitAttestation(MARKET_ID, who, 'AAAA')), 'NOT_A_SIGNER');
    assert.equal(await code(w.portal.getProgress(MARKET_ID, who)), 'NOT_A_SIGNER');
    assert.equal(await statusOf(w.portal.getProgress(MARKET_ID, who)), 403);
  } finally {
    w.restore();
  }
});

test('listing keeps unrevealed specs visible, drops finalized markets and paginates', async () => {
  const w = await world();
  try {
    const candidates = [1n, 2n, 3n, 4n].map((id) => ({
      id: `m-${id}`, question: `Q${id}`, onChainMarketId: id, expiryTimestamp: new Date(Date.now() - 1000), resolutionOracle: null,
    }));
    (w.prisma.$queryRaw as any) = async () => candidates;
    const states: Record<string, string> = { '1': 'SignersPending', '2': 'Unconfigured', '3': 'Finalized' };
    w.portal.setSignerPortalDeps({
      resolverState: async (id: bigint) => {
        if (id === 4n) throw new Error('rpc unavailable');
        return states[id.toString()];
      },
    });
    const page = await w.portal.listAwaiting(s1.publicKey(), { page: 1, limit: 10 });
    assert.equal(page.total, 3);
    assert.deepEqual(
      page.items.map((i) => [i.marketId, i.resolverState, i.blockedReason]),
      [['m-1', 'SignersPending', null], ['m-2', 'Unconfigured', 'SPEC_NOT_REVEALED'], ['m-4', 'UNKNOWN', null]],
      'finalized markets are dropped; an unreadable state is shown, not hidden',
    );
    const second = await w.portal.listAwaiting(s1.publicKey(), { page: 2, limit: 1 });
    assert.deepEqual(second.items.map((i) => i.marketId), ['m-2']);
  } finally {
    w.restore();
  }
});

test('listing checks resolver state with bounded concurrency', async () => {
  const w = await world();
  try {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`, question: 'Q', onChainMarketId: BigInt(i), expiryTimestamp: new Date(0), resolutionOracle: null,
    }));
    (w.prisma.$queryRaw as any) = async () => candidates;
    let active = 0;
    let peak = 0;
    w.portal.setSignerPortalDeps({
      resolverState: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return 'SignersPending';
      },
    });
    await w.portal.listAwaiting(s1.publicKey(), { page: 1, limit: 100 });
    assert.ok(peak <= 5, `at most 5 concurrent RPC reads (saw ${peak})`);
  } finally {
    w.restore();
  }
});

test('evidence returns the pinned question only when it matches its committed hash', async () => {
  const w = await world();
  try {
    const ev = await w.portal.getEvidence(MARKET_ID, s1.publicKey());
    assert.equal(ev.resolutionSource, 'FRED:DGS10');
    assert.equal((ev.question as any).question, 'Will it?');
    assert.equal(ev.evidenceTraces[0].url, '/api/v1/traces/tr1');
    assert.deepEqual(ev.spec.signers, w.spec.signers);

    w.portal.setSignerPortalDeps({ fetchQuestion: async () => Buffer.from('{"tampered":true}') });
    assert.equal(await code(w.portal.getEvidence(MARKET_ID, s1.publicKey())), 'IPFS_RETRIEVAL_FAILED');
    w.portal.setSignerPortalDeps({ fetchQuestion: async () => { throw new Error('gateway down'); } });
    assert.equal(await code(w.portal.getEvidence(MARKET_ID, s1.publicKey())), 'IPFS_RETRIEVAL_FAILED');
  } finally {
    w.restore();
  }
});

test('prepare returns a simulated, time-bounded transaction whose only signer is the wallet', async () => {
  const w = await world();
  try {
    const out = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    assert.equal(out.outcome, 'YES');
    assert.equal(out.networkPassphrase, w.config.STELLAR_NETWORK_PASSPHRASE);
    const tx = TransactionBuilder.fromXDR(out.xdr, w.config.STELLAR_NETWORK_PASSPHRASE) as any;
    assert.equal(tx.source, s1.publicKey(), 'the signer is the transaction source');
    assert.equal(tx.signatures.length, 0, 'unsigned');
    assert.ok(Number(tx.timeBounds.maxTime) > Math.floor(Date.now() / 1000), 'carries time bounds');
    assert.equal(new Date(out.validUntil).getTime(), Number(tx.timeBounds.maxTime) * 1000);
    const row = w.rows[0];
    assert.equal(row.status, 'PREPARED');
    assert.equal(row.preparedHash, tx.hash().toString('hex'));
    assert.equal(row.signer, s1.publicKey());
  } finally {
    w.restore();
  }
});

test('preparing the same outcome twice returns the same live transaction', async () => {
  const w = await world();
  try {
    const a = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    const b = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    assert.equal(a.xdr, b.xdr);
    assert.equal(w.state.builds, 1, 'no second simulation, no second sequence number');
    // Once it expired, a new one is built.
    w.advance(10 * 60_000);
    w.state.sequence = 2000;
    const c = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    assert.notEqual(c.xdr, a.xdr);
    assert.equal(w.rows.length, 1, 'the same (market, signer, outcome) row is reused');
  } finally {
    w.restore();
  }
});

test('simulation failures map to precise errors', async () => {
  const w = await world();
  try {
    const cases: Array<[string, string, number]> = [
      ['HostError: Error(Contract, #11)', 'NOT_A_SIGNER', 403],
      ['HostError: Error(Contract, #12)', 'ALREADY_ATTESTED', 409],
      ['HostError: Error(Contract, #7)', 'MARKET_NOT_CLOSED', 409],
      ['HostError: Error(Contract, #17)', 'ALREADY_FINALIZED', 409],
      ['HostError: Error(Contract, #5)', 'SPEC_NOT_REVEALED', 409],
      ['HostError: something else', 'SIMULATION_FAILED', 422],
    ];
    for (const [text, expected, status] of cases) {
      w.state.simError = text;
      const p = w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
      assert.equal(await code(p), expected);
      assert.equal(await statusOf(w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES')), status);
    }
    assert.equal(w.rows.length, 0, 'nothing is stored for a failed simulation');
  } finally {
    w.restore();
  }
});

test('a transaction that needs other signers is refused', async () => {
  const w = await world();
  try {
    w.state.extraSigners = [outsider.publicKey()];
    assert.equal(await code(w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES')), 'EXTRA_SIGNERS_REQUIRED');
  } finally {
    w.restore();
  }
});

test('an unrevealed spec is reported, and a finalized market is refused', async () => {
  const w = await world({ state: 'Unconfigured' });
  try {
    assert.equal(await code(w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES')), 'SPEC_NOT_REVEALED');
    w.portal.setSignerPortalDeps({ resolverState: async () => 'Finalized' });
    assert.equal(await code(w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES')), 'ALREADY_FINALIZED');
  } finally {
    w.restore();
  }
});

test('submit broadcasts the signed prepared transaction and records the ledger', async () => {
  const w = await world();
  try {
    const prepared = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'NO');
    const result = await w.portal.submitAttestation(MARKET_ID, s1.publicKey(), w.sign(prepared.xdr, s1));
    assert.deepEqual({ status: result.status, outcome: result.outcome, ledger: result.ledger }, { status: 'CONFIRMED', outcome: 'NO', ledger: 321 });
    assert.equal(w.sent.length, 1);
    assert.equal(w.rows[0].status, 'CONFIRMED');
    assert.equal(w.rows[0].txHash, w.rows[0].preparedHash);
    assert.equal(w.rows[0].ledger, 321);

    // A second submit of the same envelope does not broadcast again.
    const again = await w.portal.submitAttestation(MARKET_ID, s1.publicKey(), w.sign(prepared.xdr, s1));
    assert.equal(again.status, 'CONFIRMED');
    assert.equal(w.sent.length, 1);
  } finally {
    w.restore();
  }
});

test('submit rejects a transaction whose hash differs from the prepared one', async () => {
  const w = await world();
  try {
    const prepared = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    // Same wallet signs a different transaction (another sequence number, i.e. another body).
    const { CONTRACTS } = await import('../src/config/contracts');
    const foreign = new TransactionBuilder(new Account(s1.publicKey(), '7777'), { fee: '100', networkPassphrase: w.config.STELLAR_NETWORK_PASSPHRASE })
      .addOperation(Operation.invokeContractFunction({ contract: CONTRACTS.resolver, function: 'attest', args: [nativeToScVal(99n, { type: 'u64' })] }))
      .setTimeout(300)
      .build();
    foreign.sign(s1);
    assert.equal(await code(w.portal.submitAttestation(MARKET_ID, s1.publicKey(), foreign.toXDR())), 'PREPARED_TX_MISMATCH');
    assert.equal(w.sent.length, 0);
    assert.equal(w.rows[0].status, 'PREPARED', 'the prepared transaction is untouched');
    assert.ok(prepared.xdr);
  } finally {
    w.restore();
  }
});

test('submit rejects an expired prepared transaction with 410 PREPARED_TX_EXPIRED', async () => {
  const w = await world();
  try {
    const prepared = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    const signed = w.sign(prepared.xdr, s1);
    w.advance(10 * 60_000);
    const p = w.portal.submitAttestation(MARKET_ID, s1.publicKey(), signed);
    assert.equal(await code(p), 'PREPARED_TX_EXPIRED');
    assert.equal(await statusOf(w.portal.submitAttestation(MARKET_ID, s1.publicKey(), signed)), 410);
    assert.equal(w.sent.length, 0, 'no raw RPC error: nothing was sent');
  } finally {
    w.restore();
  }
});

test('submit needs the wallet\'s own signature over the prepared hash', async () => {
  const w = await world();
  try {
    const prepared = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    assert.equal(await code(w.portal.submitAttestation(MARKET_ID, s1.publicKey(), prepared.xdr)), 'SIGNATURE_INVALID', 'unsigned');
    assert.equal(await code(w.portal.submitAttestation(MARKET_ID, s1.publicKey(), w.sign(prepared.xdr, outsider))), 'SIGNATURE_INVALID', 'signed by someone else');
    assert.equal(w.sent.length, 0);
  } finally {
    w.restore();
  }
});

test('a changed account sequence surfaces STALE_SEQUENCE and allows a re-prepare', async () => {
  const w = await world();
  try {
    const prepared = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    w.rpcState.sendStatus = 'ERROR';
    w.rpcState.errorResult = xdr.TransactionResult.fromXDR(
      // fee 0, result code txBAD_SEQ (-5), no extension
      Buffer.from('0000000000000000FFFFFFFB00000000', 'hex'),
    );
    const p = w.portal.submitAttestation(MARKET_ID, s1.publicKey(), w.sign(prepared.xdr, s1));
    assert.equal(await code(p), 'STALE_SEQUENCE');
    assert.equal(w.rows[0].status, 'FAILED');
    assert.equal(w.rows[0].error, 'STALE_SEQUENCE');

    w.rpcState.sendStatus = 'PENDING';
    w.state.sequence = 1001;
    const again = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    assert.notEqual(again.xdr, prepared.xdr);
    assert.equal(w.rows[0].status, 'PREPARED');
  } finally {
    w.restore();
  }
});

test('an on-chain failure marks the row FAILED; an unseen result stays SUBMITTED', async () => {
  const w = await world();
  try {
    const prepared = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    w.rpcState.txStatus = 'FAILED';
    assert.equal(await code(w.portal.submitAttestation(MARKET_ID, s1.publicKey(), w.sign(prepared.xdr, s1))), 'ATTESTATION_FAILED');
    assert.equal(w.rows[0].status, 'FAILED');

    const second = await w.portal.prepareAttestation(MARKET_ID, s2.publicKey(), 'YES');
    w.rpcState.txStatus = 'NOT_FOUND';
    const pending = await w.portal.submitAttestation(MARKET_ID, s2.publicKey(), w.sign(second.xdr, s2));
    assert.equal(pending.status, 'SUBMITTED');
    assert.equal(w.rows.find((r) => r.signer === s2.publicKey()).status, 'SUBMITTED');
  } finally {
    w.restore();
  }
});

test('preparing the opposite outcome after a confirmed attestation is a CONFLICTING_ATTESTATION', async () => {
  const w = await world();
  try {
    const yes = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    await w.portal.submitAttestation(MARKET_ID, s1.publicKey(), w.sign(yes.xdr, s1));

    const p = w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'NO');
    assert.equal(await code(p), 'CONFLICTING_ATTESTATION');
    assert.equal(await statusOf(w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'NO')), 409);
    assert.equal(await code(w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES')), 'ALREADY_ATTESTED');

    const forced = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'NO', { allowConflict: true });
    assert.equal(forced.outcome, 'NO');
  } finally {
    w.restore();
  }
});

test('progress reports the threshold reached after two confirmed attestations on a 2-of-3 spec', async () => {
  const w = await world({ threshold: 2 });
  try {
    for (const k of [s1, s2]) {
      const prepared = await w.portal.prepareAttestation(MARKET_ID, k.publicKey(), 'YES');
      await w.portal.submitAttestation(MARKET_ID, k.publicKey(), w.sign(prepared.xdr, k));
    }
    const progress = await w.portal.getProgress(MARKET_ID, s3.publicKey());
    assert.equal(progress.threshold, 2);
    assert.deepEqual(progress.counts, { YES: 2, NO: 0 });
    assert.equal(progress.countsSource, 'api-observed');
    assert.equal(progress.thresholdReached, true);
    assert.equal(progress.split, false);
    assert.deepEqual(progress.attestedBy.map((a) => a.signer).sort(), [s1.publicKey(), s2.publicKey()].sort());
    assert.equal(progress.proposal, null);
    assert.equal(progress.resolverState, 'SignersPending');
  } finally {
    w.restore();
  }
});

test('progress surfaces split votes, equivocation and attestations made outside the API', async () => {
  const w = await world({ threshold: 2 });
  try {
    const yes = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'YES');
    await w.portal.submitAttestation(MARKET_ID, s1.publicKey(), w.sign(yes.xdr, s1));
    // s1 also attests NO (allowed only with allowConflict), s2 attests NO.
    const no = await w.portal.prepareAttestation(MARKET_ID, s1.publicKey(), 'NO', { allowConflict: true });
    w.state.sequence = 1100;
    await w.portal.submitAttestation(MARKET_ID, s1.publicKey(), w.sign(no.xdr, s1));
    w.setProposal({ params: { market_id: '5', outcome: { tag: 'Yes' }, proposed_at: '1700000000' } });

    const progress = await w.portal.getProgress(MARKET_ID, s2.publicKey());
    assert.equal(progress.split, true);
    assert.deepEqual(progress.equivocators, [s1.publicKey()]);
    assert.deepEqual(progress.proposal, { outcome: 'YES', proposedAt: '1700000000' });
    assert.equal(progress.thresholdReached, true);
    assert.equal(progress.attestationsOutsideApi, true, 'a proposal the observed counts cannot explain');
  } finally {
    w.restore();
  }
});

// ─── HTTP ────────────────────────────────────────────────────────────────

async function withServer(fn: (base: string) => Promise<void>) {
  const { default: app } = await import('../src/app');
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('HTTP: every signer route requires authentication', async () => {
  await withServer(async (base) => {
    const calls: Array<[string, string]> = [
      ['GET', '/signer/markets'],
      ['GET', `/signer/markets/${MARKET_ID}/evidence`],
      ['POST', `/signer/markets/${MARKET_ID}/attest/prepare`],
      ['POST', `/signer/markets/${MARKET_ID}/attest/submit`],
      ['GET', `/signer/markets/${MARKET_ID}/progress`],
    ];
    for (const [method, path] of calls) {
      const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });
});

test('HTTP: bodies, ids and the allowConflict flag are validated', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  const token = signToken('u1', s1.publicKey());
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  await withServer(async (base) => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const bad = [
      await post(`/signer/markets/${MARKET_ID}/attest/prepare`, { outcome: 'MAYBE' }),
      await post(`/signer/markets/${MARKET_ID}/attest/prepare`, {}),
      await post(`/signer/markets/not-a-uuid/attest/prepare`, { outcome: 'YES' }),
      await post(`/signer/markets/${MARKET_ID}/attest/prepare?allowConflict=maybe`, { outcome: 'YES' }),
      await post(`/signer/markets/${MARKET_ID}/attest/submit`, {}),
      await post(`/signer/markets/${MARKET_ID}/attest/submit`, { xdr: 'A'.repeat(20_001) }),
    ];
    for (const res of bad) {
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    }
  });
});

test('HTTP: a non-signer is refused with 403 NOT_A_SIGNER and a signer prepares end to end', async () => {
  const w = await world();
  const { signToken } = await import('../src/middlewares/auth.middleware');
  try {
    await withServer(async (base) => {
      const as = (kp: Keypair) => ({ authorization: `Bearer ${signToken('u', kp.publicKey())}`, 'content-type': 'application/json' });
      const refused = await fetch(`${base}/api/v1/signer/markets/${MARKET_ID}/progress`, { headers: as(outsider) });
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error.code, 'NOT_A_SIGNER');

      const prep = await fetch(`${base}/api/v1/signer/markets/${MARKET_ID}/attest/prepare`, {
        method: 'POST', headers: as(s1), body: JSON.stringify({ outcome: 'YES' }),
      });
      assert.equal(prep.status, 200);
      const body = (await prep.json()).data;
      assert.equal(body.outcome, 'YES');

      const sub = await fetch(`${base}/api/v1/signer/markets/${MARKET_ID}/attest/submit`, {
        method: 'POST', headers: as(s1), body: JSON.stringify({ xdr: w.sign(body.xdr, s1) }),
      });
      assert.equal(sub.status, 200);
      assert.equal((await sub.json()).data.status, 'CONFIRMED');

      const progress = await fetch(`${base}/api/v1/signer/markets/${MARKET_ID}/progress`, { headers: as(s2) });
      assert.deepEqual((await progress.json()).data.counts, { YES: 1, NO: 0 });
    });
  } finally {
    w.restore();
  }
});
