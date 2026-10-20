/**
 * SEP-45 web authentication for contract (C…) accounts (#47).
 *
 * A smart-wallet account has no ed25519 key that can sign a classic SEP-10
 * challenge. SEP-45 instead uses Soroban authorization entries: the server
 * builds entries for `web_auth_verify` on the configured web-auth contract,
 * signs its own entry, and the client's wallet signs its entry. Verification
 * re-checks the arguments and the server signature, then *simulates* the
 * invocation so the client contract's `__check_auth` runs on-chain.
 */
import crypto from 'node:crypto';
import {
  Account,
  Address,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { getRedis, withRedis } from '../lib/redis';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { signToken } from '../middlewares/auth.middleware';
import { currentServerKey } from './auth.service';
import { AUTH_KEY_PREFIX } from '../lib/redis-scripts';
import { withTimeout } from '../lib/resilience';

export const SEP45_NONCE_PREFIX = `${AUTH_KEY_PREFIX}sep45:`;
const SEP45_NONCE_TTL_SECONDS = 300;
/** ~5 minutes of ledgers at 5 s per ledger. */
const SEP45_VALID_LEDGERS = 60;

export interface Sep45Challenge {
  authorization_entries: string;
  network_passphrase: string;
  expires_at: string;
}

export interface Sep45Verification {
  token: string;
  userId: string;
  walletAddress: string;
}

export interface Simulator {
  simulate(tx: Transaction, authMode?: rpc.Api.SimulationAuthMode): Promise<rpc.Api.SimulateTransactionResponse>;
  /** Latest ledger sequence, used to bound signature expirations. */
  getLatestLedger?(): Promise<number>;
}

let simulator: Simulator | null = null;

/** Replaces the simulator (tests); returns the previous one. */
export function setSimulator(next: Simulator | null): Simulator | null {
  const prev = simulator;
  simulator = next;
  return prev;
}

/** Persists the challenge nonce so it can be spent exactly once. */
export interface Sep45NonceStore {
  put(nonce: string, account: string, validUntilLedger: number, ttlSeconds: number): Promise<void>;
  take(nonce: string): Promise<{ account: string; validUntilLedger: number } | null>;
}

/** In-memory nonce store for tests. */
export class MemoryNonceStore implements Sep45NonceStore {
  private readonly items = new Map<string, { account: string; validUntilLedger: number; expiresAt: number }>();

  async put(nonce: string, account: string, validUntilLedger: number, ttlSeconds: number): Promise<void> {
    this.items.set(nonce, { account, validUntilLedger, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async take(nonce: string): Promise<{ account: string; validUntilLedger: number } | null> {
    const record = this.items.get(nonce);
    if (!record) return null;
    this.items.delete(nonce);
    if (record.expiresAt <= Date.now()) return null;
    return { account: record.account, validUntilLedger: record.validUntilLedger };
  }
}

const redisNonceStore: Sep45NonceStore = {
  async put(nonce, account, validUntilLedger, ttlSeconds) {
    await withRedis(() =>
      getRedis().set(
        `${SEP45_NONCE_PREFIX}${nonce}`,
        JSON.stringify({ account, validUntilLedger }),
        'EX',
        ttlSeconds,
      ),
    );
  },
  async take(nonce) {
    const raw = await withRedis(() => getRedis().getdel(`${SEP45_NONCE_PREFIX}${nonce}`));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { account: string; validUntilLedger: number };
    } catch {
      return null;
    }
  },
};

let nonceStore: Sep45NonceStore = redisNonceStore;

/** Replaces the nonce store (tests); returns the previous one. */
export function setNonceStore(next: Sep45NonceStore | null): Sep45NonceStore {
  const prev = nonceStore;
  nonceStore = next ?? redisNonceStore;
  return prev;
}

function rpcServerForSep45(): rpc.Server {
  return new rpc.Server(config.SEP45_RPC_URL || config.STELLAR_RPC_URL, {
    allowHttp: (config.SEP45_RPC_URL || config.STELLAR_RPC_URL).startsWith('http://'),
  });
}

function getSimulator(): Simulator {
  if (simulator) return simulator;
  const server = rpcServerForSep45();
  return {
    simulate: (tx, authMode) => server.simulateTransaction(tx, undefined, authMode ?? 'enforce'),
    getLatestLedger: async () => (await server.getLatestLedger()).sequence,
  };
}

function unavailable(message = 'SEP-45 login is temporarily unavailable'): AppError {
  return new AppError(503, 'AUTH_UNAVAILABLE', message, { retryAfterSecs: 5 });
}

function sep45Disabled(): AppError {
  return new AppError(503, 'SEP45_UNAVAILABLE', 'Contract-account login is not enabled on this server');
}

function assertEnabled(): { contractId: string; serverKey: Keypair } {
  if (!config.SEP45_ENABLED || !config.WEB_AUTH_CONTRACT_ID) throw sep45Disabled();
  const key = currentServerKey();
  return { contractId: config.WEB_AUTH_CONTRACT_ID, serverKey: key.keypair! };
}

function symbolString(key: string, value: string): xdr.ScMapEntry {
  return new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol(key),
    val: xdr.ScVal.scvString(value),
  });
}

interface ChallengeArgs {
  account: string;
  homeDomain: string;
  webAuthDomain: string;
  webAuthDomainAccount: string;
  nonce: string;
}

function argsScVal(args: ChallengeArgs): xdr.ScVal {
  // ScMap keys must be sorted (the host rejects unsorted maps).
  return xdr.ScVal.scvMap([
    symbolString('account', args.account),
    symbolString('home_domain', args.homeDomain),
    symbolString('nonce', args.nonce),
    symbolString('web_auth_domain', args.webAuthDomain),
    symbolString('web_auth_domain_account', args.webAuthDomainAccount),
  ]);
}

/** A positive int64 nonce for the address credentials. */
function randomNonce(): bigint {
  const bytes = crypto.randomBytes(8);
  bytes[0] &= 0x7f;
  const value = bytes.readBigUInt64BE(0);
  return value === 0n ? 1n : value;
}

function invocationFor(contractId: string, args: xdr.ScVal): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: 'web_auth_verify',
        args: [args],
      }),
    ),
    subInvocations: [],
  });
}

function addressCredentials(address: string, nonce: bigint, validUntilLedger: number): xdr.SorobanCredentials {
  return xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: Address.fromString(address).toScAddress(),
      nonce: new xdr.Int64(nonce),
      signatureExpirationLedger: validUntilLedger,
      signature: xdr.ScVal.scvVoid(),
    }),
  );
}

async function currentLedger(): Promise<number> {
  const sim = getSimulator();
  try {
    if (sim.getLatestLedger) return await withTimeout('rpc-read', () => sim.getLatestLedger!());
    return await withTimeout('rpc-read', async () => (await rpcServerForSep45().getLatestLedger()).sequence);
  } catch {
    throw unavailable();
  }
}

/** GET /auth/contract/challenge. */
export async function createContractChallenge(
  account: unknown,
  homeDomain?: unknown,
): Promise<Sep45Challenge> {
  const { contractId, serverKey } = assertEnabled();
  if (typeof account !== 'string' || !StrKey.isValidContract(account)) {
    throw new AppError(400, 'INVALID_ADDRESS', 'account must be a contract address (C…)');
  }
  if (homeDomain !== undefined && homeDomain !== null && homeDomain !== '') {
    if (typeof homeDomain !== 'string' || homeDomain !== config.AUTH_HOME_DOMAIN) {
      throw new AppError(400, 'INVALID_HOME_DOMAIN', 'home_domain does not match this server');
    }
  }

  const latest = await currentLedger();
  const validUntilLedger = latest + SEP45_VALID_LEDGERS;
  const nonce = crypto.randomBytes(32).toString('hex');
  const args = argsScVal({
    account,
    homeDomain: config.AUTH_HOME_DOMAIN,
    webAuthDomain: config.AUTH_WEB_AUTH_DOMAIN,
    webAuthDomainAccount: serverKey.publicKey(),
    nonce,
  });

  const invocation = invocationFor(contractId, args);
  const clientEntry = new xdr.SorobanAuthorizationEntry({
    credentials: addressCredentials(account, randomNonce(), validUntilLedger),
    rootInvocation: invocation,
  });
  const serverEntry = new xdr.SorobanAuthorizationEntry({
    credentials: addressCredentials(serverKey.publicKey(), randomNonce(), validUntilLedger),
    rootInvocation: invocation,
  });

  let signedServerEntry: xdr.SorobanAuthorizationEntry;
  try {
    // `authorizeEntry` sets the expiration on a clone and signs the preimage.
    signedServerEntry = await authorizeEntry(
      serverEntry,
      serverKey,
      validUntilLedger,
      config.STELLAR_NETWORK_PASSPHRASE,
    );
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not sign SEP-45 server entry');
    throw unavailable();
  }

  try {
    await nonceStore.put(nonce, account, validUntilLedger, SEP45_NONCE_TTL_SECONDS);
  } catch (err) {
    throw unavailable();
  }

  return {
    authorization_entries: xdr.SorobanAuthorizationEntries.toXDR([clientEntry, signedServerEntry]).toString('base64'),
    network_passphrase: config.STELLAR_NETWORK_PASSPHRASE,
    expires_at: new Date(Date.now() + SEP45_NONCE_TTL_SECONDS * 1000).toISOString(),
  };
}

interface DecodedEntry {
  address: string;
  entry: xdr.SorobanAuthorizationEntry;
  args: ChallengeArgs;
  expiration: number;
}

function contractArgsMap(entry: xdr.SorobanAuthorizationEntry, contractId: string): ChallengeArgs {
  const root = entry.rootInvocation();
  const fn = root.function();
  if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The authorization entry is not a contract invocation');
  }
  if (root.subInvocations().length > 0) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The authorization entry has sub-invocations');
  }
  const call = fn.contractFn();
  const contract = Address.fromScAddress(call.contractAddress()).toString();
  if (contract !== contractId) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The authorization entry targets a different contract');
  }
  if (call.functionName().toString() !== 'web_auth_verify') {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The authorization entry calls the wrong function');
  }
  const args = call.args();
  if (args.length !== 1) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The authorization entry has malformed arguments');
  }
  const native = scValToNative(args[0]) as Record<string, unknown> | null;
  if (!native || typeof native !== 'object' || Array.isArray(native)) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The authorization entry arguments are not a map');
  }
  const str = (key: string): string => {
    const value = native[key];
    if (typeof value !== 'string') {
      throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', `The authorization entry is missing ${key}`);
    }
    return value;
  };
  return {
    account: str('account'),
    homeDomain: str('home_domain'),
    webAuthDomain: str('web_auth_domain'),
    webAuthDomainAccount: str('web_auth_domain_account'),
    nonce: str('nonce'),
  };
}

function entryAddress(entry: xdr.SorobanAuthorizationEntry): string {
  const credentials = entry.credentials();
  if (credentials.switch().name !== 'sorobanCredentialsAddress') {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The authorization entry does not use address credentials');
  }
  return Address.fromScAddress(credentials.address().address()).toString();
}

/** Extracts the server's ed25519 signature from the entry's signature ScVal. */
function extractSignature(signature: xdr.ScVal): Buffer {
  let native: unknown;
  try {
    native = scValToNative(signature);
  } catch {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The server signature is malformed');
  }
  const first = Array.isArray(native) ? native[0] : native;
  const raw = first && typeof first === 'object' ? (first as Record<string, unknown>).signature : null;
  const value = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : null;
  if (!value) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The server signature is missing');
  }
  return value;
}

function verifyServerSignature(entry: xdr.SorobanAuthorizationEntry, serverPublic: string): void {
  const credentials = entry.credentials().address();
  const expiration = credentials.signatureExpirationLedger();
  const preimage = buildAuthorizationEntryPreimage(
    entry,
    expiration,
    config.STELLAR_NETWORK_PASSPHRASE,
  );
  const payload = hash(preimage.toXDR());
  const signature = extractSignature(credentials.signature());
  if (!Keypair.fromPublicKey(serverPublic).verify(payload, signature)) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The server signature is invalid');
  }
}

function decodeEntries(encoded: unknown): xdr.SorobanAuthorizationEntry[] {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new AppError(400, 'INVALID_CHALLENGE', 'authorization_entries must be a base64 string');
  }
  if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024) {
    throw new AppError(400, 'INVALID_CHALLENGE', 'authorization_entries is too large');
  }
  try {
    return xdr.SorobanAuthorizationEntries.fromXDR(encoded, 'base64');
  } catch {
    throw new AppError(400, 'INVALID_CHALLENGE', 'authorization_entries is not a valid SorobanAuthorizationEntries XDR');
  }
}

/** POST /auth/contract/verify. */
export async function verifyContractChallenge(encoded: unknown): Promise<Sep45Verification> {
  const { contractId, serverKey } = assertEnabled();
  const entries = decodeEntries(encoded);
  if (entries.length !== 2) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'Expected exactly two authorization entries');
  }

  const serverPublic = serverKey.publicKey();
  let serverEntry: DecodedEntry | null = null;
  let clientEntry: DecodedEntry | null = null;

  for (const entry of entries) {
    const address = entryAddress(entry);
    const args = contractArgsMap(entry, contractId);
    const expiration = entry.credentials().address().signatureExpirationLedger();
    const decoded: DecodedEntry = { address, entry, args, expiration };
    if (address === serverPublic) {
      if (serverEntry) throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'Duplicate server authorization entry');
      serverEntry = decoded;
    } else if (StrKey.isValidContract(address)) {
      if (clientEntry) throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'Duplicate client authorization entry');
      clientEntry = decoded;
    } else {
      throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'Unexpected authorization entry address');
    }
  }
  if (!serverEntry || !clientEntry) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'Missing server or client authorization entry');
  }

  // Both entries must commit to the same challenge arguments.
  const a = serverEntry.args;
  const b = clientEntry.args;
  const same =
    a.account === b.account &&
    a.homeDomain === b.homeDomain &&
    a.webAuthDomain === b.webAuthDomain &&
    a.webAuthDomainAccount === b.webAuthDomainAccount &&
    a.nonce === b.nonce;
  if (!same) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The authorization entries disagree on the challenge arguments');
  }
  if (
    a.homeDomain !== config.AUTH_HOME_DOMAIN ||
    a.webAuthDomain !== config.AUTH_WEB_AUTH_DOMAIN ||
    a.webAuthDomainAccount !== serverPublic ||
    a.account !== clientEntry.address
  ) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge arguments do not match this server');
  }

  verifyServerSignature(serverEntry.entry, serverPublic);

  // Single use: consumed before simulation, so a captured payload cannot be
  // retried even if simulation or the user upsert later fails.
  let stored: { account: string; validUntilLedger: number } | null = null;
  try {
    stored = await nonceStore.take(a.nonce);
  } catch {
    throw unavailable();
  }
  if (!stored) {
    throw new AppError(401, 'CHALLENGE_NOT_FOUND', 'Unknown or already used challenge. Request a new one.');
  }
  if (stored.account !== clientEntry.address) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge was issued for a different account');
  }
  // The server's entry expiration is exactly what the nonce was issued with
  // (the server signature binds it); the client picks its own near-future
  // expiration. Both must still be ahead of the current ledger.
  if (serverEntry.expiration !== stored.validUntilLedger) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The server authorization expiration does not match');
  }
  const ledger = await currentLedger();
  if (ledger >= clientEntry.expiration || ledger >= serverEntry.expiration) {
    throw new AppError(401, 'CHALLENGE_EXPIRED', 'The challenge authorization has expired. Request a new one.');
  }

  const tx = new TransactionBuilder(new Account(serverPublic, '0'), {
    fee: '100',
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: 'web_auth_verify',
            args: [argsScVal(a)],
          }),
        ),
        auth: [clientEntry.entry, serverEntry.entry],
      }),
    )
    .setTimeout(0)
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await withTimeout('rpc-read', () => getSimulator().simulate(tx, 'enforce'));
  } catch {
    throw unavailable();
  }

  if (rpc.Api.isSimulationError(simulation)) {
    logger.warn({ error: simulation.error }, 'SEP-45 simulation rejected the client authorization');
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The contract did not authorize this login');
  }
  if (simulation.latestLedger >= clientEntry.expiration) {
    throw new AppError(401, 'CHALLENGE_EXPIRED', 'The challenge authorization has expired. Request a new one.');
  }

  const user = await prisma.user.upsert({
    where: { identityKey: clientEntry.address },
    create: {
      walletAddress: clientEntry.address,
      identityKey: clientEntry.address,
    },
    update: {},
  });

  return {
    token: signToken(user.id, clientEntry.address, {
      account: clientEntry.address,
      accountType: 'contract',
      authTime: Math.floor(Date.now() / 1000),
    }),
    userId: user.id,
    walletAddress: clientEntry.address,
  };
}
