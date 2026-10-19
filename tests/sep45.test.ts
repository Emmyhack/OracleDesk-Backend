import test from 'node:test';
import assert from 'node:assert/strict';
import { Address, authorizeEntry, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const OTHER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 9));
process.env.SEP45_ENABLED = 'true';
process.env.WEB_AUTH_CONTRACT_ID = CONTRACT_ID;

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code ?? e.message);

async function setup(ledger = 100, simulateError = false) {
  const sep45 = await import('../src/services/sep45.service');
  const { config } = await import('../src/config');
  const { prisma } = await import('../src/lib/prisma');
  (prisma.user.upsert as any) = async ({ where }: any) => ({ id: 'user-1', identityKey: where.identityKey });
  const store = new sep45.MemoryNonceStore();
  sep45.setNonceStore(store);
  sep45.setSimulator({
    async getLatestLedger() {
      return ledger;
    },
    async simulate() {
      return simulateError
        ? ({ error: 'HostError: Error(Auth, InvalidAction)', latestLedger: ledger } as any)
        : ({ latestLedger: ledger, transactionData: {}, result: {} } as any);
    },
  });
  return { sep45, config, store };
}

function decode(encoded: string): xdr.SorobanAuthorizationEntry[] {
  return xdr.SorobanAuthorizationEntries.fromXDR(encoded, 'base64');
}

/** Assembles a client + (optionally signed) server entry pair with raw args. */
async function buildEntries(opts: {
  nonce?: string;
  account?: string;
  homeDomain?: string;
  contractId?: string;
  serverHomeDomain?: string;
  signServer?: boolean;
  expiration?: number;
} = {}) {
  const { config } = await import('../src/config');
  const { currentServerKey } = await import('../src/services/auth.service');
  const server = currentServerKey().keypair!;
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(16).slice(2)}`;
  const account = opts.account ?? CONTRACT_ID;
  const contractId = opts.contractId ?? CONTRACT_ID;
  const homeDomain = opts.homeDomain ?? 'localhost';
  const serverHomeDomain = opts.serverHomeDomain ?? homeDomain;
  const expiration = opts.expiration ?? 160;

  const argMap = (hd: string): xdr.ScVal =>
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('account'), val: xdr.ScVal.scvString(account) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('home_domain'), val: xdr.ScVal.scvString(hd) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('nonce'), val: xdr.ScVal.scvString(nonce) }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('web_auth_domain'),
        val: xdr.ScVal.scvString(config.AUTH_WEB_AUTH_DOMAIN),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('web_auth_domain_account'),
        val: xdr.ScVal.scvString(server.publicKey()),
      }),
    ]);

  const entry = (args: xdr.ScVal, address: string): xdr.SorobanAuthorizationEntry =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(address).toScAddress(),
          nonce: new xdr.Int64(1n),
          signatureExpirationLedger: expiration,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: 'web_auth_verify',
            args: [args],
          }),
        ),
        subInvocations: [],
      }),
    });

  const client = entry(argMap(homeDomain), account);
  let serverEntry = entry(argMap(serverHomeDomain), server.publicKey());
  if (opts.signServer !== false) {
    serverEntry = await authorizeEntry(serverEntry, server, expiration, config.STELLAR_NETWORK_PASSPHRASE);
  }
  return {
    encoded: xdr.SorobanAuthorizationEntries.toXDR([client, serverEntry]).toString('base64'),
    nonce,
    account,
    expiration,
  };
}

test('returns a two-entry challenge: unsigned client first, server-signed second', async () => {
  const { sep45, config } = await setup();
  const challenge = await sep45.createContractChallenge(CONTRACT_ID);
  assert.equal(challenge.network_passphrase, config.STELLAR_NETWORK_PASSPHRASE);
  const entries = decode(challenge.authorization_entries);
  assert.equal(entries.length, 2);

  const client = entries[0].credentials().address();
  assert.equal(Address.fromScAddress(client.address()).toString(), CONTRACT_ID);
  assert.equal(entries[0].credentials().switch().name, 'sorobanCredentialsAddress');
  assert.equal(client.signature().switch().name, 'scvVoid');
  assert.equal(entries[1].credentials().address().signature().switch().name, 'scvVec');
  assert.equal(entries[0].rootInvocation().function().contractFn().functionName().toString(), 'web_auth_verify');
});

test('happy path: verification simulates and issues a JWT for the contract address', async () => {
  const { sep45 } = await setup();
  const challenge = await sep45.createContractChallenge(CONTRACT_ID, 'localhost');
  const result = await sep45.verifyContractChallenge(challenge.authorization_entries);
  assert.equal(result.walletAddress, CONTRACT_ID);
  assert.equal(result.token.split('.').length, 3);
});

test('a challenge nonce is single use', async () => {
  const { sep45 } = await setup();
  const challenge = await sep45.createContractChallenge(CONTRACT_ID);
  await sep45.verifyContractChallenge(challenge.authorization_entries);
  assert.equal(await code(sep45.verifyContractChallenge(challenge.authorization_entries)), 'CHALLENGE_NOT_FOUND');
});

test('an unknown nonce is rejected', async () => {
  const { sep45 } = await setup();
  const built = await buildEntries();
  assert.equal(await code(sep45.verifyContractChallenge(built.encoded)), 'CHALLENGE_NOT_FOUND');
});

test('an altered home_domain in the client entry is rejected', async () => {
  const { sep45, store } = await setup();
  const built = await buildEntries({ homeDomain: 'evil.example', serverHomeDomain: 'localhost' });
  await store.put(built.nonce, built.account, built.expiration, 300);
  assert.equal(await code(sep45.verifyContractChallenge(built.encoded)), 'CHALLENGE_SIGNATURE_INVALID');
});

test('a missing server signature is rejected', async () => {
  const { sep45, store } = await setup();
  const built = await buildEntries({ signServer: false });
  await store.put(built.nonce, built.account, built.expiration, 300);
  assert.equal(await code(sep45.verifyContractChallenge(built.encoded)), 'CHALLENGE_SIGNATURE_INVALID');
});

test('entries for a different web-auth contract are rejected', async () => {
  const { sep45, store } = await setup();
  const built = await buildEntries({ contractId: OTHER_CONTRACT_ID });
  await store.put(built.nonce, built.account, built.expiration, 300);
  assert.equal(await code(sep45.verifyContractChallenge(built.encoded)), 'CHALLENGE_SIGNATURE_INVALID');
});

test('a failed contract simulation is rejected', async () => {
  const { sep45 } = await setup(100, true);
  const challenge = await sep45.createContractChallenge(CONTRACT_ID);
  assert.equal(await code(sep45.verifyContractChallenge(challenge.authorization_entries)), 'CHALLENGE_SIGNATURE_INVALID');
});

test('an expired challenge is rejected', async () => {
  const { sep45 } = await setup(100);
  const challenge = await sep45.createContractChallenge(CONTRACT_ID);
  // Push the latest ledger past the challenge expiration.
  sep45.setSimulator({
    async getLatestLedger() {
      return 100 + 1000;
    },
    async simulate() {
      return { latestLedger: 100 + 1000, transactionData: {}, result: {} } as any;
    },
  });
  assert.equal(await code(sep45.verifyContractChallenge(challenge.authorization_entries)), 'CHALLENGE_EXPIRED');
});

test('an unreachable RPC maps to AUTH_UNAVAILABLE, not a 401', async () => {
  const { sep45 } = await setup();
  sep45.setSimulator({
    async getLatestLedger() {
      throw new Error('connect ECONNREFUSED');
    },
    async simulate() {
      throw new Error('connect ECONNREFUSED');
    },
  });
  assert.equal(await code(sep45.createContractChallenge(CONTRACT_ID)), 'AUTH_UNAVAILABLE');
});

test('rejects non-contract accounts and foreign home domains', async () => {
  const { sep45 } = await setup();
  assert.equal(await code(sep45.createContractChallenge(Keypair.random().publicKey())), 'INVALID_ADDRESS');
  assert.equal(await code(sep45.createContractChallenge('CABC')), 'INVALID_ADDRESS');
  assert.equal(await code(sep45.createContractChallenge(undefined)), 'INVALID_ADDRESS');
  assert.equal(await code(sep45.createContractChallenge(CONTRACT_ID, 'evil.example')), 'INVALID_HOME_DOMAIN');
});

test('is disabled unless SEP45_ENABLED and a contract id are configured', async () => {
  const { sep45, config } = await setup();
  const previous = { enabled: config.SEP45_ENABLED, contractId: config.WEB_AUTH_CONTRACT_ID };
  try {
    (config as any).SEP45_ENABLED = false;
    assert.equal(await code(sep45.createContractChallenge(CONTRACT_ID)), 'SEP45_UNAVAILABLE');
  } finally {
    (config as any).SEP45_ENABLED = previous.enabled;
    (config as any).WEB_AUTH_CONTRACT_ID = previous.contractId;
  }
});

test('a contract session is never an admin', async () => {
  const { config } = await setup();
  const { signToken, isAdminToken } = await import('../src/middlewares/auth.middleware');
  (config as any).ADMIN_ADDRESSES = [Keypair.random().publicKey()];
  const contractToken = signToken('u1', CONTRACT_ID, { account: CONTRACT_ID, accountType: 'contract' });
  assert.equal(await isAdminToken(contractToken), false);
});
