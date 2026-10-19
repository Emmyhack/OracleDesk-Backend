/**
 * Wallet login with a SEP-10 style challenge transaction.
 *
 * The server builds a transaction (sequence 0, so it can never be submitted)
 * signed by AUTH_SIGNING_SECRET. The wallet signs it with `signTransaction`,
 * which every Stellar wallet supports (signMessage/SEP-53 is not universal).
 * Challenges are single-use and expire after CHALLENGE_TTL_SECONDS.
 *
 * Login identities (#46): a base G… account (optionally with an id memo), or an
 * M… muxed account (CAP-27 / SEP-23). The signature always comes from the base
 * G… key; the sub-identity is bound into the challenge and stored with it.
 */
import { Keypair, MuxedAccount, StrKey, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import type { SubIdKind } from '@prisma/client';
import { config } from '../config';
import { secret } from '../config/secrets';
import { prisma } from '../lib/prisma';
import { getRedis } from '../lib/redis';
import { AppError } from '../middlewares/error.middleware';
import { signToken } from '../middlewares/auth.middleware';

export const CHALLENGE_TTL_SECONDS = 300;

/** Largest valid uint64 sub-identity id (2^64 - 1). */
export const MAX_SUB_ID = 18446744073709551615n;

/**
 * A parsed wallet login identity.
 *
 * - `account` is the base G… key that signs and pays.
 * - `subId` / `subIdKind` identify the custodial sub-user, or are null for a
 *   plain G… account.
 * - `challengeAccount` is what goes into the challenge's client account slot
 *   (the M… address for muxed users, the G… address otherwise).
 * - `display` is the canonical login string (`M…` or `G…:memo`).
 */
export interface LoginIdentity {
  account: string;
  subId: string | null;
  subIdKind: SubIdKind | null;
  challengeAccount: string;
  display: string;
}

/**
 * The value stored for an issued challenge. #45 extends this with the optional
 * client domain / client signing key.
 */
export interface ChallengeRecord {
  account: string;
  subId: string | null;
  subIdKind: SubIdKind | null;
  challengeAccount: string;
  display: string;
}

/** Storage for issued challenges, keyed by transaction hash. */
export interface ChallengeStore {
  put(hash: string, record: ChallengeRecord, ttlSeconds: number): Promise<void>;
  /** Atomically returns and deletes the entry (single use). */
  take(hash: string): Promise<ChallengeRecord | null>;
}

/** Values written before #46 were the plain address string. */
function parseStoredChallenge(raw: string): ChallengeRecord {
  try {
    const parsed = JSON.parse(raw) as Partial<ChallengeRecord> | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.account === 'string') {
      return {
        account: parsed.account,
        subId: typeof parsed.subId === 'string' ? parsed.subId : null,
        subIdKind: parsed.subIdKind === 'MUXED' || parsed.subIdKind === 'MEMO' ? parsed.subIdKind : null,
        challengeAccount: typeof parsed.challengeAccount === 'string' ? parsed.challengeAccount : parsed.account,
        display: typeof parsed.display === 'string' ? parsed.display : parsed.account,
      };
    }
  } catch {
    // Not JSON: a legacy plain address value.
  }
  return { account: raw, subId: null, subIdKind: null, challengeAccount: raw, display: raw };
}

export const redisChallengeStore: ChallengeStore = {
  async put(hash, record, ttl) {
    await getRedis().set(`auth:challenge:${hash}`, JSON.stringify(record), 'EX', ttl);
  },
  async take(hash) {
    const raw = await getRedis().getdel(`auth:challenge:${hash}`);
    return raw === null ? null : parseStoredChallenge(raw);
  },
};

export class MemoryChallengeStore implements ChallengeStore {
  private readonly entries = new Map<string, { record: ChallengeRecord; expires: number }>();
  async put(hash: string, record: ChallengeRecord, ttl: number) {
    this.entries.set(hash, { record, expires: Date.now() + ttl * 1000 });
  }
  async take(hash: string) {
    const entry = this.entries.get(hash);
    this.entries.delete(hash);
    return entry && entry.expires > Date.now() ? entry.record : null;
  }
}

let store: ChallengeStore = redisChallengeStore;
export function setChallengeStore(next: ChallengeStore): ChallengeStore {
  const prev = store;
  store = next;
  return prev;
}

const serverKeypair = () => Keypair.fromSecret(secret('AUTH_SIGNING_SECRET'));

export function assertStellarAccount(address: unknown): asserts address is string {
  if (typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address)) {
    throw new AppError(400, 'INVALID_ADDRESS', 'address must be a Stellar public key (G…)');
  }
}

/** Normalises a memo request field to a canonical decimal uint64 string. */
function normalizeMemoId(memo: unknown): string {
  let digits: string;
  if (typeof memo === 'number') {
    if (!Number.isSafeInteger(memo) || memo < 0) {
      throw new AppError(400, 'INVALID_MEMO', 'memo must be a decimal uint64 string');
    }
    digits = String(memo);
  } else if (typeof memo === 'string') {
    digits = memo.trim();
  } else {
    throw new AppError(400, 'INVALID_MEMO', 'memo must be a decimal uint64 string');
  }
  if (!/^[0-9]+$/.test(digits)) {
    throw new AppError(400, 'INVALID_MEMO', 'memo must be a decimal uint64 string');
  }
  const value = BigInt(digits);
  if (value < 0n || value > MAX_SUB_ID) {
    throw new AppError(400, 'INVALID_MEMO', 'memo is outside the unsigned 64-bit range');
  }
  // Canonical decimal, so the identityKey is stable across leading zeros.
  return value.toString();
}

/**
 * Parses a login identity from a wallet address and optional memo (#46).
 *
 * Accepts a G… account, a G… account with an id memo, or an M… muxed address.
 * A memo combined with an M… address is rejected, as are text/hash memos,
 * out-of-range ids and malformed input. Id 0 and the uint64 maximum are valid
 * (SEP-10 allows a MemoID of 0 and the SDK accepts the full range).
 */
export function parseLoginIdentity(address: unknown, memo?: unknown): LoginIdentity {
  if (typeof address !== 'string') {
    throw new AppError(400, 'INVALID_ADDRESS', 'address must be a Stellar public key (G… or M…)');
  }
  const hasMemo = memo !== undefined && memo !== null && memo !== '';

  if (StrKey.isValidMed25519PublicKey(address)) {
    if (hasMemo) {
      throw new AppError(400, 'INVALID_MEMO', 'A memo cannot be combined with a muxed (M…) account');
    }
    // Re-encode from the parsed account (never upper-case) so the id and the
    // canonical M… string are taken from StrKey, not from the raw input.
    const muxed = MuxedAccount.fromAddress(address, '0');
    const account = muxed.baseAccount().accountId();
    const canonical = muxed.accountId();
    return { account, subId: muxed.id(), subIdKind: 'MUXED', challengeAccount: canonical, display: canonical };
  }

  if (StrKey.isValidEd25519PublicKey(address)) {
    if (!hasMemo) {
      return { account: address, subId: null, subIdKind: null, challengeAccount: address, display: address };
    }
    const subId = normalizeMemoId(memo);
    return { account: address, subId, subIdKind: 'MEMO', challengeAccount: address, display: `${address}:${subId}` };
  }

  throw new AppError(400, 'INVALID_ADDRESS', 'address must be a Stellar public key (G… or M…)');
}

/** Unique per (base account, sub-identity); the value behind `users.identityKey`. */
export function identityKeyFor(identity: LoginIdentity): string {
  if (identity.subId == null) return identity.account;
  const kind = identity.subIdKind === 'MUXED' ? 'muxed' : 'memo';
  return `${identity.account}#${kind}:${identity.subId}`;
}

export async function createChallenge(address: unknown, memo?: unknown): Promise<{
  transaction: string;
  networkPassphrase: string;
  expiresAt: string;
}> {
  const identity = parseLoginIdentity(address, memo);
  const memoArg = identity.subIdKind === 'MEMO' ? identity.subId : null;
  const transaction = WebAuth.buildChallengeTx(
    serverKeypair(),
    identity.challengeAccount,
    config.AUTH_HOME_DOMAIN,
    CHALLENGE_TTL_SECONDS,
    config.STELLAR_NETWORK_PASSPHRASE,
    config.AUTH_WEB_AUTH_DOMAIN,
    memoArg,
  );
  const tx = TransactionBuilder.fromXDR(transaction, config.STELLAR_NETWORK_PASSPHRASE);
  const record: ChallengeRecord = {
    account: identity.account,
    subId: identity.subId,
    subIdKind: identity.subIdKind,
    challengeAccount: identity.challengeAccount,
    display: identity.display,
  };
  await store.put(tx.hash().toString('hex'), record, CHALLENGE_TTL_SECONDS);
  return {
    transaction,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function verifyChallenge(address: unknown, signed: unknown, memo?: unknown): Promise<{
  token: string;
  userId: string;
  walletAddress: string;
}> {
  const identity = parseLoginIdentity(address, memo);
  if (typeof signed !== 'string' || signed.length === 0) {
    throw new AppError(400, 'INVALID_CHALLENGE', 'signed must be a base64 transaction envelope');
  }
  const serverAccount = serverKeypair().publicKey();

  let clientAccountID: string;
  let challengeMemo: string | null;
  let hash: string;
  try {
    const read = WebAuth.readChallengeTx(
      signed,
      serverAccount,
      config.STELLAR_NETWORK_PASSPHRASE,
      config.AUTH_HOME_DOMAIN,
      config.AUTH_WEB_AUTH_DOMAIN,
    );
    clientAccountID = read.clientAccountID;
    challengeMemo = read.memo ?? null;
    hash = read.tx.hash().toString('hex');
    // readChallengeTx allows a grace period past the time bounds; we don't.
    const maxTime = Number(read.tx.timeBounds?.maxTime ?? 0);
    if (!maxTime || Math.floor(Date.now() / 1000) > maxTime) {
      throw new AppError(401, 'CHALLENGE_EXPIRED', 'The challenge has expired. Request a new one.');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/expired|time ?bounds/i.test(message)) {
      throw new AppError(401, 'CHALLENGE_EXPIRED', 'The challenge has expired. Request a new one.');
    }
    throw new AppError(400, 'INVALID_CHALLENGE', 'The signed challenge could not be read', { reason: message });
  }

  // Single use: consumed here even if a later check fails.
  const record = await store.take(hash);
  if (!record) {
    throw new AppError(401, 'CHALLENGE_NOT_FOUND', 'Unknown or already used challenge. Request a new one.');
  }
  // The account and the sub-identity that come back from the challenge must be
  // the ones that were issued and stored.
  if (
    clientAccountID !== identity.challengeAccount ||
    record.account !== identity.account ||
    record.subId !== identity.subId ||
    record.subIdKind !== identity.subIdKind ||
    record.challengeAccount !== identity.challengeAccount
  ) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge was issued for a different identity');
  }
  const expectedMemo = identity.subIdKind === 'MEMO' ? identity.subId : null;
  if ((challengeMemo ?? null) !== expectedMemo) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge memo does not match the login identity');
  }

  let signers: string[];
  try {
    // The signer set must equal exactly the base G… key.
    signers = WebAuth.verifyChallengeTxSigners(
      signed,
      serverAccount,
      config.STELLAR_NETWORK_PASSPHRASE,
      [identity.account],
      config.AUTH_HOME_DOMAIN,
      config.AUTH_WEB_AUTH_DOMAIN,
    );
  } catch {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge is not signed by this account');
  }
  if (signers.length !== 1 || signers[0] !== identity.account) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge is not signed by this account');
  }

  const identityKey = identityKeyFor(identity);
  const user = await prisma.user.upsert({
    where: { identityKey },
    create: {
      walletAddress: identity.account,
      subId: identity.subId,
      subIdKind: identity.subIdKind,
      identityKey,
    },
    update: {},
  });
  return {
    token: signToken(user.id, identity.account, {
      account: identity.account,
      subId: identity.subId,
      subIdKind: identity.subIdKind,
    }),
    userId: user.id,
    walletAddress: identity.account,
  };
}
