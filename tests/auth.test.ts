import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

async function setup() {
  const auth = await import('../src/services/auth.service');
  const { prisma } = await import('../src/lib/prisma');
  (prisma.user.upsert as any) = async ({ where }: any) => ({ id: 'user-1', identityKey: where.identityKey });
  auth.setChallengeStore(new auth.MemoryChallengeStore());
  const { config } = await import('../src/config');
  return { auth, config };
}

function sign(challengeXdr: string, passphrase: string, ...signers: Keypair[]): string {
  const tx = TransactionBuilder.fromXDR(challengeXdr, passphrase);
  for (const kp of signers) tx.sign(kp);
  return tx.toXDR();
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code ?? e.message);

test('challenge → sign → verify issues a JWT for that address', async () => {
  const { auth, config } = await setup();
  const user = Keypair.random();
  const ch = await auth.createChallenge(user.publicKey());
  assert.equal(ch.networkPassphrase, config.STELLAR_NETWORK_PASSPHRASE);
  const result = await auth.verifyChallenge(user.publicKey(), sign(ch.transaction, ch.networkPassphrase, user));
  assert.equal(result.walletAddress, user.publicKey());
  assert.ok(result.token.split('.').length === 3);
});

test('rejects invalid and EVM addresses', async () => {
  const { auth } = await setup();
  assert.equal(await code(auth.createChallenge('0x0000000000000000000000000000000000000001')), 'INVALID_ADDRESS');
  assert.equal(await code(auth.createChallenge('GABC')), 'INVALID_ADDRESS');
  assert.equal(await code(auth.createChallenge(undefined)), 'INVALID_ADDRESS');
  // A secret seed is not an address.
  assert.equal(await code(auth.createChallenge(Keypair.random().secret())), 'INVALID_ADDRESS');
});

test('a challenge works once', async () => {
  const { auth } = await setup();
  const user = Keypair.random();
  const ch = await auth.createChallenge(user.publicKey());
  const signed = sign(ch.transaction, ch.networkPassphrase, user);
  assert.equal(await code(auth.verifyChallenge(user.publicKey(), signed)), 'ok');
  assert.equal(await code(auth.verifyChallenge(user.publicKey(), signed)), 'CHALLENGE_NOT_FOUND');
});

test('wrong signer, missing signature and address swap are rejected', async () => {
  const { auth } = await setup();
  const user = Keypair.random();
  const attacker = Keypair.random();

  let ch = await auth.createChallenge(user.publicKey());
  assert.equal(await code(auth.verifyChallenge(user.publicKey(), sign(ch.transaction, ch.networkPassphrase, attacker))), 'CHALLENGE_SIGNATURE_INVALID');

  ch = await auth.createChallenge(user.publicKey());
  assert.equal(await code(auth.verifyChallenge(user.publicKey(), ch.transaction)), 'CHALLENGE_SIGNATURE_INVALID');

  // Attacker signs their own challenge but claims the victim's address.
  ch = await auth.createChallenge(attacker.publicKey());
  assert.equal(await code(auth.verifyChallenge(user.publicKey(), sign(ch.transaction, ch.networkPassphrase, attacker))), 'CHALLENGE_SIGNATURE_INVALID');
});

test('a challenge not issued by this server is rejected', async () => {
  const { auth, config } = await setup();
  const { WebAuth } = await import('@stellar/stellar-sdk');
  const user = Keypair.random();
  const forged = WebAuth.buildChallengeTx(Keypair.random(), user.publicKey(), config.AUTH_HOME_DOMAIN, 300,
    config.STELLAR_NETWORK_PASSPHRASE, config.AUTH_WEB_AUTH_DOMAIN);
  // The hash is unknown to the store, so it is consumed-without-effect and
  // reported as an unknown challenge (not a signature problem).
  assert.equal(await code(auth.verifyChallenge(user.publicKey(), sign(forged, config.STELLAR_NETWORK_PASSPHRASE, user))), 'CHALLENGE_NOT_FOUND');
});

test('an expired challenge is rejected', async () => {
  const { auth } = await setup();
  const user = Keypair.random();
  const ch = await auth.createChallenge(user.publicKey());
  const signed = sign(ch.transaction, ch.networkPassphrase, user);
  const realNow = Date.now;
  Date.now = () => realNow() + (auth.CHALLENGE_TTL_SECONDS + 1) * 1000;
  try {
    assert.equal(await code(auth.verifyChallenge(user.publicKey(), signed)), 'CHALLENGE_EXPIRED');
  } finally {
    Date.now = realNow;
  }
});

// ─── #46 sub-identities ─────────────────────────────────────────────────

test('a muxed (M…) login signs with the base key and maps to it', async () => {
  const { auth } = await setup();
  const { MuxedAccount, Account } = await import('@stellar/stellar-sdk');
  const base = Keypair.random();
  const muxed = new MuxedAccount(new Account(base.publicKey(), '0'), '7').accountId();

  const identity = auth.parseLoginIdentity(muxed);
  assert.equal(identity.account, base.publicKey());
  assert.equal(identity.subId, '7');
  assert.equal(identity.subIdKind, 'MUXED');

  const ch = await auth.createChallenge(muxed);
  const result = await auth.verifyChallenge(muxed, sign(ch.transaction, ch.networkPassphrase, base));
  assert.equal(result.walletAddress, base.publicKey());
});

test('a G… login with an id memo maps to that sub-identity', async () => {
  const { auth } = await setup();
  const base = Keypair.random();
  const identity = auth.parseLoginIdentity(base.publicKey(), '42');
  assert.equal(identity.account, base.publicKey());
  assert.equal(identity.subId, '42');
  assert.equal(identity.subIdKind, 'MEMO');

  const ch = await auth.createChallenge(base.publicKey(), '42');
  const result = await auth.verifyChallenge(base.publicKey(), sign(ch.transaction, ch.networkPassphrase, base), '42');
  assert.equal(result.walletAddress, base.publicKey());
});

test('id 0 and the uint64 max are valid identities; text and out-of-range are not', async () => {
  const { auth } = await setup();
  const base = Keypair.random();
  assert.equal(auth.parseLoginIdentity(base.publicKey(), '0').subId, '0');
  assert.equal(auth.parseLoginIdentity(base.publicKey(), '18446744073709551615').subId, '18446744073709551615');
  assert.equal(auth.parseLoginIdentity(base.publicKey(), 0).subId, '0');
  assert.equal(await code(Promise.resolve().then(() => auth.parseLoginIdentity(base.publicKey(), '18446744073709551616'))), 'INVALID_MEMO');
  assert.equal(await code(Promise.resolve().then(() => auth.parseLoginIdentity(base.publicKey(), 'not-a-number'))), 'INVALID_MEMO');
  assert.equal(await code(Promise.resolve().then(() => auth.parseLoginIdentity(base.publicKey(), 2 ** 53))), 'INVALID_MEMO');
});

test('a memo combined with a muxed address is rejected', async () => {
  const { auth } = await setup();
  const { MuxedAccount, Account } = await import('@stellar/stellar-sdk');
  const base = Keypair.random();
  const muxed = new MuxedAccount(new Account(base.publicKey(), '0'), '7').accountId();
  assert.equal(await code(Promise.resolve().then(() => auth.parseLoginIdentity(muxed, '7'))), 'INVALID_MEMO');
});

test('a challenge for one memo cannot be verified as another', async () => {
  const { auth } = await setup();
  const base = Keypair.random();
  const ch = await auth.createChallenge(base.publicKey(), '42');
  const signed = sign(ch.transaction, ch.networkPassphrase, base);
  assert.equal(await code(auth.verifyChallenge(base.publicKey(), signed, '43')), 'CHALLENGE_SIGNATURE_INVALID');
});

// ─── #48 signing-key rotation ───────────────────────────────────────────

test('a challenge signed by a previous key still verifies during the overlap', async () => {
  const { auth, config } = await setup();
  const { setSecretsForTest } = await import('../src/config/secrets');
  const oldKey = Keypair.random();
  const newKey = Keypair.random();
  const user = Keypair.random();

  setSecretsForTest({ AUTH_SIGNING_SECRET: oldKey.secret() });
  const ch = await auth.createChallenge(user.publicKey());
  const signed = sign(ch.transaction, ch.networkPassphrase, user);

  setSecretsForTest({ AUTH_SIGNING_SECRET: newKey.secret() });
  (config as any).AUTH_PREVIOUS_SIGNING_KEYS = [{ publicKey: oldKey.publicKey(), retireAt: null }];
  try {
    const result = await auth.verifyChallenge(user.publicKey(), signed);
    assert.equal(result.walletAddress, user.publicKey());
  } finally {
    (config as any).AUTH_PREVIOUS_SIGNING_KEYS = [];
    setSecretsForTest({ AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET ?? '' });
  }
});

test('a retired or unknown issuing key is rejected (#48)', async () => {
  const { auth, config } = await setup();
  const { setSecretsForTest } = await import('../src/config/secrets');
  const { TransactionBuilder } = await import('@stellar/stellar-sdk');
  const oldKey = Keypair.random();
  const unknown = Keypair.random();
  const user = Keypair.random();

  // A retired previous key: past retirement is not accepted.
  setSecretsForTest({ AUTH_SIGNING_SECRET: oldKey.secret() });
  const retired = await auth.createChallenge(user.publicKey());
  (config as any).AUTH_PREVIOUS_SIGNING_KEYS = [
    { publicKey: oldKey.publicKey(), retireAt: new Date(Date.now() - 1000) },
  ];
  try {
    assert.equal(
      await code(auth.verifyChallenge(user.publicKey(), sign(retired.transaction, retired.networkPassphrase, user))),
      'INVALID_CHALLENGE',
    );
  } finally {
    (config as any).AUTH_PREVIOUS_SIGNING_KEYS = [];
  }

  // A record that claims an unknown issuer is rejected after consumption.
  const ch = await auth.createChallenge(user.publicKey());
  const hash = TransactionBuilder.fromXDR(ch.transaction, ch.networkPassphrase).hash().toString('hex');
  const store = new auth.MemoryChallengeStore();
  await store.put(
    hash,
    {
      account: user.publicKey(),
      subId: null,
      subIdKind: null,
      challengeAccount: user.publicKey(),
      display: user.publicKey(),
      issuer: unknown.publicKey(),
      issuedAt: Date.now(),
    },
    auth.CHALLENGE_TTL_SECONDS,
  );
  auth.setChallengeStore(store);
  try {
    assert.equal(
      await code(auth.verifyChallenge(user.publicKey(), sign(ch.transaction, ch.networkPassphrase, user))),
      'INVALID_CHALLENGE',
    );
  } finally {
    setSecretsForTest({ AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET ?? '' });
    auth.setChallengeStore(new auth.MemoryChallengeStore());
  }
});

// ─── #50 proof of work ─────────────────────────────────────────────────

test('proof of work accepts only a solution meeting the bit target', async () => {
  const { auth } = await setup();
  const address = Keypair.random().publicKey();
  const salt = 'test-salt';

  let nonce = 0;
  while (!auth.verifyPow(address, String(nonce), salt, 8)) nonce += 1;
  assert.ok(auth.verifyPow(address, String(nonce), salt, 8));
  assert.equal(auth.verifyPow(address, String(nonce), 'other-salt', 8), false);
  assert.equal(auth.verifyPow(address, String(nonce + 100), salt, 8), false);});
