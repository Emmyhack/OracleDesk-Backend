/**
 * Transaction outbox and fee-bump recovery (#38).
 *
 * The outbox was not present when fee bumps landed, so this module adds the
 * minimal persistence the fee-bump worker needs: every live write stores its
 * signed inner envelope (identity = inner hash) and a recovery pass polls the
 * stored hashes and wraps stuck rows in a fee bump. Fee bumps never rebuild the
 * inner transaction, so the inner hash, sequence, auth entries and arguments
 * are preserved and at most one envelope can execute.
 */
import { Keypair, Transaction, TransactionBuilder, rpc } from '@stellar/stellar-sdk';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { rpcServer } from './clients';
import { FeeBumpCapExceeded, buildFeeBump, innerInclusionPerOp, planBump } from './fee-bump';

export type OutboxStatus = 'PENDING' | 'SUBMITTED' | 'SUCCESS' | 'FAILED' | 'EXPIRED';

export interface ChainTransactionRow {
  id: string;
  kind: string;
  refId: string | null;
  hash: string;
  envelopeXdr: string;
  status: string;
  submitLedger: number | null;
  maxTime: bigint | null;
  innerFee: string | null;
  resourceFee: string | null;
  feeBumpHashes: string[];
  feeBumpEnvelopes: unknown;
  landedHash: string | null;
  bumpAttempts: number;
}

// Prisma's client is generated from the schema; the cast keeps this module
// compilable before `prisma generate` has run for the new table.
const outbox = () => (prisma as unknown as {
  chainTransaction: {
    upsert(args: unknown): Promise<ChainTransactionRow>;
    updateMany(args: unknown): Promise<{ count: number }>;
    findMany(args: unknown): Promise<ChainTransactionRow[]>;
    findFirst(args: unknown): Promise<ChainTransactionRow | null>;
  };
}).chainTransaction;

/** Persists a signed inner envelope before it is sent. Idempotent on the hash. */
export async function recordTransaction(input: {
  kind: string;
  refId?: string | null;
  hash: string;
  envelopeXdr: string;
  maxTime?: bigint | null;
  innerFee?: bigint | null;
  resourceFee?: bigint | null;
}): Promise<void> {
  await outbox().upsert({
    where: { hash: input.hash },
    update: {},
    create: {
      kind: input.kind,
      refId: input.refId ?? null,
      hash: input.hash,
      envelopeXdr: input.envelopeXdr,
      maxTime: input.maxTime ?? null,
      innerFee: input.innerFee?.toString() ?? null,
      resourceFee: input.resourceFee?.toString() ?? null,
      status: 'PENDING',
    },
  });
}

export async function markSubmitted(hash: string, submitLedger: number): Promise<void> {
  await outbox().updateMany({ where: { hash, status: 'PENDING' }, data: { status: 'SUBMITTED', submitLedger } });
}

export async function findRowByAnyHash(hashes: string[]): Promise<ChainTransactionRow | null> {
  if (hashes.length === 0) return null;
  return outbox().findFirst({
    where: { OR: [{ hash: { in: hashes } }, { landedHash: { in: hashes } }, { feeBumpHashes: { hasSome: hashes } }] },
  });
}

/** The inner (identity) hash for any outer/inner hash, or null if unknown. */
export async function innerHashForTx(txHash: string): Promise<string | null> {
  const row = await findRowByAnyHash([txHash]);
  return row ? row.hash : null;
}

/**
 * After a bump lands, the domain row must store the hash that actually appears
 * on chain (outer) plus the inner hash for reference (#38).
 */
async function applyLandedHash(row: ChainTransactionRow, landedHash: string): Promise<void> {
  const db = prisma as unknown as {
    trade: { updateMany(args: unknown): Promise<unknown> };
    market: { updateMany(args: unknown): Promise<unknown> };
    reasoningTrace: { updateMany(args: unknown): Promise<unknown> };
  };
  try {
    if (row.kind === 'trade' && row.refId) {
      await db.trade.updateMany({ where: { id: row.refId }, data: { txHash: landedHash, innerTxHash: row.hash } });
    } else if (row.kind === 'market' && row.refId) {
      await db.market.updateMany({ where: { id: row.refId }, data: { creationTxHash: landedHash, creationInnerTxHash: row.hash } });
    } else if (row.kind === 'trace' && row.refId) {
      await db.reasoningTrace.updateMany({ where: { id: row.refId }, data: { publishTxHash: landedHash, publishInnerTxHash: row.hash } });
    }
  } catch (err) {
    logger.warn({ err, hash: row.hash, landedHash }, 'fee bump: could not record the landed hash on the domain row');
  }
}

export interface BumpGate {
  status: string;
  submitLedger: number | null;
  maxTime: bigint | null;
  bumpAttempts: number;
}

/**
 * Whether a row may be fee-bumped now: pending past the threshold, under the
 * attempt cap, and not within one ledger of its inner maxTime (a bump cannot
 * extend timebounds).
 */
export function shouldBump(row: BumpGate, latestLedger: number, nowSecs: number, opts: { afterLedgers: number; maxAttempts: number }): boolean {
  if (row.status !== 'PENDING' && row.status !== 'SUBMITTED') return false;
  if (row.submitLedger == null) return false;
  if (row.bumpAttempts >= opts.maxAttempts) return false;
  if (latestLedger - row.submitLedger < opts.afterLedgers) return false;
  if (row.maxTime != null && BigInt(nowSecs) >= row.maxTime - 5n) return false;
  return true;
}

export interface RecoverDeps {
  server?: Pick<rpc.Server, 'getLatestLedger' | 'getTransaction' | 'sendTransaction'>;
  now?: () => number;
  ledgerOverride?: number;
  feePayer?: Keypair;
}

function feePayerKeypair(deps: RecoverDeps): Keypair {
  if (deps.feePayer) return deps.feePayer;
  return Keypair.fromSecret(config.FEE_PAYER_SECRET);
}

/**
 * One recovery pass: poll in-flight rows by every known hash, resolve the row
 * with whichever hash landed, and fee-bump the ones stuck past the threshold.
 */
export async function recoverInFlight(deps: RecoverDeps = {}): Promise<{ resolved: number; bumped: number }> {
  const server = deps.server ?? rpcServer;
  const nowSecs = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const rows = await outbox().findMany({
    where: { status: { in: ['PENDING', 'SUBMITTED'] } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  if (rows.length === 0) return { resolved: 0, bumped: 0 };

  const latestLedger = deps.ledgerOverride ?? (await server.getLatestLedger()).sequence;
  let resolved = 0;
  let bumped = 0;

  for (const row of rows) {
    const hashes = [row.hash, ...(row.feeBumpHashes ?? [])];
    let landed: { hash: string; status: string } | null = null;
    for (const hash of hashes) {
      const resp = await server.getTransaction(hash);
      if (resp.status === 'SUCCESS' || resp.status === 'FAILED') {
        landed = { hash, status: resp.status };
        break;
      }
    }
    if (landed) {
      await outbox().updateMany({
        where: { id: row.id, status: { in: ['PENDING', 'SUBMITTED'] } },
        data: { status: landed.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED', landedHash: landed.hash },
      });
      if (landed.status === 'SUCCESS') await applyLandedHash(row, landed.hash);
      resolved++;
      continue;
    }

    if (!config.FEE_BUMP_ENABLED) continue;
    if (!shouldBump(row, latestLedger, nowSecs, {
      afterLedgers: config.FEE_BUMP_AFTER_LEDGERS,
      maxAttempts: config.FEE_BUMP_MAX_ATTEMPTS,
    })) {
      continue;
    }
    if (await bumpRow(row, server, feePayerKeypair(deps))) bumped++;
  }

  return { resolved, bumped };
}

async function bumpRow(
  row: ChainTransactionRow,
  server: Pick<rpc.Server, 'getTransaction' | 'sendTransaction'>,
  feePayer: Keypair,
): Promise<boolean> {
  let inner: Transaction;
  try {
    inner = TransactionBuilder.fromXDR(row.envelopeXdr, config.STELLAR_NETWORK_PASSPHRASE) as Transaction;
  } catch (err) {
    logger.error({ err, hash: row.hash }, 'fee bump: stored envelope could not be parsed');
    return false;
  }

  const prev = row.feeBumpEnvelopes && Array.isArray(row.feeBumpEnvelopes) && row.feeBumpEnvelopes.length > 0
    ? BigInt((row.feeBumpEnvelopes as Array<{ inclusionPerOp?: string }>)[row.feeBumpEnvelopes.length - 1].inclusionPerOp ?? innerInclusionPerOp(inner).toString())
    : innerInclusionPerOp(inner);

  let outer;
  try {
    const plan = planBump(inner, prev, {
      multiplier: config.FEE_BUMP_MULTIPLIER,
      maxStroops: BigInt(config.FEE_BUMP_MAX_STROOPS),
    });
    outer = buildFeeBump(inner, plan, feePayer.publicKey(), config.STELLAR_NETWORK_PASSPHRASE);
    outer.sign(feePayer);
  } catch (err) {
    if (err instanceof FeeBumpCapExceeded) {
      logger.warn({ hash: row.hash, outerFee: err.outerFee.toString() }, 'fee bump: cap exceeded; leaving row pending');
      await outbox().updateMany({ where: { id: row.id }, data: { error: 'FEE_BUMP_CAP_EXCEEDED' } });
      return false;
    }
    logger.error({ err, hash: row.hash }, 'fee bump: could not build a bump');
    return false;
  }

  const outerHash = outer.hash().toString('hex');
  const envelope = { hash: outerHash, fee: String(outer.fee), xdr: outer.toEnvelope().toXDR('base64'), at: new Date().toISOString() };

  // Compare-and-set on bumpAttempts so two workers produce one bump per attempt.
  const transition = await outbox().updateMany({
    where: { id: row.id, bumpAttempts: row.bumpAttempts, status: { in: ['PENDING', 'SUBMITTED'] } },
    data: {
      bumpAttempts: row.bumpAttempts + 1,
      feeBumpHashes: { push: outerHash },
      feeBumpEnvelopes: { push: envelope },
    },
  });
  if (transition.count === 0) return false;

  // Persisted before sending, as for every submission.
  try {
    const resp = await server.sendTransaction(outer);
    if (resp.status === 'ERROR') {
      // Expected after the inner already landed; poll before deciding.
      const recheck = await server.getTransaction(row.hash);
      if (recheck.status === 'SUCCESS' || recheck.status === 'FAILED') {
        await outbox().updateMany({
          where: { id: row.id },
          data: { status: recheck.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED', landedHash: row.hash },
        });
      }
    }
  } catch (err) {
    logger.warn({ err, hash: row.hash, outerHash }, 'fee bump: submit errored; will re-poll');
  }
  logger.info({ hash: row.hash, outerHash, fee: String(outer.fee) }, 'fee bump submitted');
  return true;
}
