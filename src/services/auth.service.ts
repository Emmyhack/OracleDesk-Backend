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
import crypto from 'node:crypto';
import { Keypair, MuxedAccount, StrKey, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import type { SubIdKind } from '@prisma/client';
import { config } from '../config';
import { secret } from '../config/secrets';
import { prisma } from '../lib/prisma';
import { getRedis, RedisUnavailableError, withRedis } from '../lib/redis';
import {
  AUTH_CHALLENGE_PREFIX,
  ISSUE_CHALLENGE_SCRIPT,
  authAddressKey,
  authChallengeKey,
  authIpKey,
  authIssuedKey,
  authPowKey,
} from '../lib/redis-scripts';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { signToken } from '../middlewares/auth.middleware';

export const CHALLENGE_TTL_SECONDS = config.AUTH_CHALLENGE_TTL_SECONDS;

/** A server signing key: the current one, or a previous one in its overlap. */
export interface ServerKey {
  publicKey: string;
  /** Present only for the current key; previous keys are verify-only. */
  keypair?: Keypair;
  retireAt: Date | null;
  current: boolean;
}

/** The key that signs every new challenge (#48). */
export function currentServerKey(): ServerKey {
  const keypair = Keypair.fromSecret(secret('AUTH_SIGNING_SECRET'));
  return { publicKey: keypair.publicKey(), keypair, retireAt: null, current: true };
}

/**
 * Looks up a key that may verify a challenge. Returns null for unknown keys
 * and for previous keys past their retirement time. The current key is always
 * accepted.
 */
export function serverKeyByPublic(publicKey: string, now: Date = new Date()): ServerKey | null {
  const current = currentServerKey();
  if (publicKey === current.publicKey) return current;
  const previous = config.AUTH_PREVIOUS_SIGNING_KEYS.find((k) => k.publicKey === publicKey);
  if (!previous) return null;
  if (previous.retireAt && now.getTime() >= previous.retireAt.getTime()) return null;
  return { publicKey: previous.publicKey, retireAt: previous.retireAt, current: false };
}

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
  /** Public key that signed the challenge (#48). */
  issuer: string;
  /** When the challenge was issued (ms since epoch). */
  issuedAt: number;
}

/** Storage for issued challenges, keyed by transaction hash. */
export interface ChallengeStore {
  put(hash: string, record: ChallengeRecord, ttlSeconds: number): Promise<void>;
  /** Atomically returns and deletes the entry (single use). */
  take(hash: string): Promise<ChallengeRecord | null>;
  /**
   * Atomically stores a challenge and updates the per-address and per-IP
   * outstanding counters (#50). The address cap evicts the oldest challenge;
   * the IP cap refuses issuance. Falls back to `put` when not implemented.
   */
  issue?(
    hash: string,
    record: ChallengeRecord,
    ttlSeconds: number,
    accounting: { address: string; ipHash: string },
  ): Promise<{ ipLimited: boolean; globalCount: number }>;
}

/**
 * Parses a stored challenge. Values written before #46 were the plain address
 * string; values written before #48 had no `issuer`. Legacy entries fall back
 * to the current key, which is correct for challenges issued before the first
 * rotation and expire within CHALLENGE_TTL_SECONDS.
 */
function parseStoredChallenge(raw: string): ChallengeRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ChallengeRecord> | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.account === 'string') {
      return {
        account: parsed.account,
        subId: typeof parsed.subId === 'string' ? parsed.subId : null,
        subIdKind: parsed.subIdKind === 'MUXED' || parsed.subIdKind === 'MEMO' ? parsed.subIdKind : null,
        challengeAccount: typeof parsed.challengeAccount === 'string' ? parsed.challengeAccount : parsed.account,
        display: typeof parsed.display === 'string' ? parsed.display : parsed.account,
        issuer: typeof parsed.issuer === 'string' ? parsed.issuer : currentServerKey().publicKey,
        issuedAt: typeof parsed.issuedAt === 'number' ? parsed.issuedAt : Date.now(),
      };
    }
  } catch {
    // Not JSON: a legacy plain address value.
  }
  if (StrKey.isValidEd25519PublicKey(raw) || StrKey.isValidMed25519PublicKey(raw)) {
    return {
      account: raw,
      subId: null,
      subIdKind: null,
      challengeAccount: raw,
      display: raw,
      issuer: currentServerKey().publicKey,
      issuedAt: Date.now(),
    };
  }
  // Unexpected shape: treat as not found rather than throwing a 500.
  return null;
}

export const redisChallengeStore: ChallengeStore = {
  async put(hash, record, ttl) {
    await withRedis(() => getRedis().set(authChallengeKey(hash), JSON.stringify(record), 'EX', ttl));
  },
  async take(hash) {
    const raw = await withRedis(() => getRedis().getdel(authChallengeKey(hash)));
    return raw === null ? null : parseStoredChallenge(raw);
  },
  async issue(hash, record, ttl, { address, ipHash }) {
    const minute = Math.floor(Date.now() / 60_000);
    const result = (await withRedis(() =>
      getRedis().eval(
        ISSUE_CHALLENGE_SCRIPT,
        4,
        authChallengeKey(hash),
        authAddressKey(address),
        authIpKey(ipHash),
        authIssuedKey(minute),
        JSON.stringify(record),
        String(ttl),
        String(Date.now()),
        String(config.AUTH_MAX_OUTSTANDING_PER_ADDRESS),
        String(config.AUTH_MAX_OUTSTANDING_PER_IP),
        AUTH_CHALLENGE_PREFIX,
        hash,
      ),
    )) as [number, number];
    return { ipLimited: Number(result?.[0]) === -1, globalCount: Number(result?.[1] ?? 0) };
  },
};

export class MemoryChallengeStore implements ChallengeStore {
  private readonly entries = new Map<string, { record: ChallengeRecord; expires: number }>();
  private readonly byAddress = new Map<string, string[]>();
  private readonly byIp = new Map<string, string[]>();
  private issued = 0;

  async put(hash: string, record: ChallengeRecord, ttl: number) {
    this.entries.set(hash, { record, expires: Date.now() + ttl * 1000 });
  }
  async take(hash: string) {
    const entry = this.entries.get(hash);
    this.entries.delete(hash);
    return entry && entry.expires > Date.now() ? entry.record : null;
  }
  async issue(
    hash: string,
    record: ChallengeRecord,
    ttl: number,
    { address, ipHash }: { address: string; ipHash: string },
  ) {
    this.issued += 1;
    const now = Date.now();
    const live = (list: string[]) => list.filter((h) => (this.entries.get(h)?.expires ?? 0) > now);
    const ipList = live(this.byIp.get(ipHash) ?? []);
    if (ipList.length >= config.AUTH_MAX_OUTSTANDING_PER_IP) {
      this.byIp.set(ipHash, ipList);
      return { ipLimited: true, globalCount: this.issued };
    }
    const addrList = live(this.byAddress.get(address) ?? []);
    while (addrList.length >= config.AUTH_MAX_OUTSTANDING_PER_ADDRESS) {
      const oldest = addrList.shift();
      if (oldest) {
        this.entries.delete(oldest);
        const idx = ipList.indexOf(oldest);
        if (idx >= 0) ipList.splice(idx, 1);
      }
    }
    this.entries.set(hash, { record, expires: now + ttl * 1000 });
    addrList.push(hash);
    ipList.push(hash);
    this.byAddress.set(address, addrList);
    this.byIp.set(ipHash, ipList);
    return { ipLimited: false, globalCount: this.issued };
  }
}

let store: ChallengeStore = redisChallengeStore;
export function setChallengeStore(next: ChallengeStore): ChallengeStore {
  const prev = store;
  store = next;
  return prev;
}

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

export interface CreateChallengeOptions {
  /** Client IP as Express computed it (`req.ip`). */
  ip?: string | null;
  /** Proof-of-work solution when the global burst threshold is exceeded. */
  pow?: { nonce: string; salt: string } | null;
}

export interface IssuedChallenge {
  transaction: string;
  networkPassphrase: string;
  expiresAt: string;
  /** Present when PoW is currently required (also sent as `X-Auth-PoW`). */
  pow?: { bits: number; salt: string };
}

/** Hashes an IP (or its /64 for IPv6) so Redis never stores raw addresses. */
export function hashClientIp(ip: string | null | undefined): string {
  const raw = (ip ?? 'unknown').trim().toLowerCase();
  const normalized = raw.includes(':') ? raw.split(':').slice(0, 4).join(':') : raw;
  return crypto.createHash('sha256').update(`${config.AUTH_IP_HASH_SALT}:${normalized}`).digest('hex');
}

const powPayload = (address: string, nonce: string, salt: string) =>
  `oracledesk-auth:${address}:${nonce}:${salt}`;

/** Leading zero bits of a SHA-256 digest. */
export function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** Checks a PoW solution; returns false when it does not meet the threshold. */
export function verifyPow(address: string, nonce: string, salt: string, bits = config.AUTH_POW_BITS): boolean {
  if (!nonce || !salt) return false;
  const digest = crypto.createHash('sha256').update(powPayload(address, nonce, salt)).digest();
  return leadingZeroBits(digest) >= bits;
}

/** Issues a single-use PoW salt, valid for AUTH_POW_TTL_SECONDS. */
export async function createPowSalt(): Promise<{ salt: string; bits: number; expiresAt: string }> {
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    await withRedis(() =>
      getRedis().set(authPowKey(salt), '1', 'EX', config.AUTH_POW_TTL_SECONDS),
    );
  } catch (err) {
    throw authUnavailable(err);
  }
  return {
    salt,
    bits: config.AUTH_POW_BITS,
    expiresAt: new Date(Date.now() + config.AUTH_POW_TTL_SECONDS * 1000).toISOString(),
  };
}

/** Consumes a PoW salt; false when it is unknown or already used. */
async function consumePowSalt(salt: string): Promise<boolean> {
  const raw = await withRedis(() => getRedis().getdel(authPowKey(salt)));
  return raw !== null;
}

/** The global per-minute issuance counter (0 when Redis is unavailable). */
async function issuedThisMinute(): Promise<number> {
  const minute = Math.floor(Date.now() / 60_000);
  try {
    const raw = await withRedis(() => getRedis().get(authIssuedKey(minute)));
    return Number(raw ?? 0);
  } catch (err) {
    // PoW is a burst throttle, not a correctness gate: if the counter cannot be
    // read, treat the burst as low and keep issuing (issuance itself still
    // fails closed in redisChallengeStore when Redis is down).
    if (err instanceof RedisUnavailableError) return 0;
    throw err;
  }
}

function authUnavailable(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof RedisUnavailableError || err instanceof Error) {
    logger.error({ err: err.message }, 'Auth store unavailable');
  }
  return new AppError(503, 'AUTH_UNAVAILABLE', 'Login is temporarily unavailable', {
    retryAfterSecs: 5,
  });
}

export async function createChallenge(
  address: unknown,
  memo?: unknown,
  options: CreateChallengeOptions = {},
): Promise<IssuedChallenge> {
  const identity = parseLoginIdentity(address, memo);
  const memoArg = identity.subIdKind === 'MEMO' ? identity.subId : null;
  const key = currentServerKey();

  // Proof-of-work switches on only above the configured burst rate. The
  // counter is read before building, so normal traffic never pays for it.
  let requiredPow: { bits: number; salt: string } | null = null;
  if (config.AUTH_POW_THRESHOLD_PER_MIN > 0) {
    const count = await issuedThisMinute();
    if (count >= config.AUTH_POW_THRESHOLD_PER_MIN) {
      const solution = options.pow;
      if (!solution || !solution.nonce || !solution.salt) {
        // Hand the client a fresh single-use salt so it can solve immediately.
        const challenge = await createPowSalt();
        throw new AppError(429, 'POW_REQUIRED', 'Proof of work is required during a login burst', {
          bits: challenge.bits,
          salt: challenge.salt,
          retryAfterSecs: 1,
        });
      }
      if (!verifyPow(identity.account, solution.nonce, solution.salt)) {
        throw new AppError(429, 'POW_INVALID', 'The proof-of-work solution is invalid', {
          bits: config.AUTH_POW_BITS,
        });
      }
      let consumed: boolean;
      try {
        consumed = await consumePowSalt(solution.salt);
      } catch (err) {
        throw authUnavailable(err);
      }
      if (!consumed) {
        throw new AppError(429, 'POW_INVALID', 'The proof-of-work salt is unknown or already used');
      }
      requiredPow = { bits: config.AUTH_POW_BITS, salt: solution.salt };
    }
  }

  const transaction = WebAuth.buildChallengeTx(
    key.keypair!,
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
    issuer: key.publicKey,
    issuedAt: Date.now(),
  };

  const hash = tx.hash().toString('hex');
  const ipHash = hashClientIp(options.ip);
  try {
    if (store.issue) {
      const result = await store.issue(hash, record, CHALLENGE_TTL_SECONDS, { address: identity.account, ipHash });
      if (result.ipLimited) {
        throw new AppError(429, 'AUTH_IP_LIMIT', 'Too many outstanding challenges from this network', {
          retryAfterSecs: 30,
        });
      }
    } else {
      await store.put(hash, record, CHALLENGE_TTL_SECONDS);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw authUnavailable(err);
  }

  return {
    transaction,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    ...(requiredPow ? { pow: requiredPow } : {}),
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

  // The challenge hash does not depend on signatures, so the store entry can
  // be consumed (single use) before any trust decision. The record names the
  // key that issued the challenge; that key is the only one allowed to verify.
  let hash: string;
  try {
    hash = TransactionBuilder.fromXDR(signed, config.STELLAR_NETWORK_PASSPHRASE).hash().toString('hex');
  } catch (err) {
    throw new AppError(400, 'INVALID_CHALLENGE', 'The signed challenge could not be read', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // Never fall back to accepting a challenge without a successful GETDEL.
  let record: ChallengeRecord | null;
  try {
    record = await store.take(hash);
  } catch (err) {
    throw authUnavailable(err);
  }
  if (!record) {
    throw new AppError(401, 'CHALLENGE_NOT_FOUND', 'Unknown or already used challenge. Request a new one.');
  }

  const issuerKey = serverKeyByPublic(record.issuer);
  if (!issuerKey) {
    // A key we no longer trust (retired or unknown) cannot verify a challenge
    // it claims to have issued. The record is already consumed.
    throw new AppError(401, 'INVALID_CHALLENGE', 'The challenge was signed by a key that is no longer accepted', {
      issuer: record.issuer,
    });
  }
  if (!issuerKey.current) {
    logger.info(
      { issuer: issuerKey.publicKey, retireAt: issuerKey.retireAt?.toISOString() ?? null },
      'Challenge verified with a previous signing key',
    );
  }
  const serverAccount = issuerKey.publicKey;

  let clientAccountID: string;
  let challengeMemo: string | null;
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
      authTime: Math.floor(Date.now() / 1000),
    }),
    userId: user.id,
    walletAddress: identity.account,
  };
}
