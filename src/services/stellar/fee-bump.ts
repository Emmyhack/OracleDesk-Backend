/**
 * Soroban fee bumps (#38).
 *
 * A stuck transaction (inclusion fee below the surge price) is not rebuilt: a
 * rebuilt transaction is a new hash with a new sequence that can execute
 * alongside the original, which would double-execute a treasury trade. Instead
 * the stored inner envelope is wrapped unchanged in a `FeeBumpTransaction` paid
 * by a separate account, so at most one of the two envelopes can ever land.
 *
 * The inner hash stays the identity; the outer (fee-bump) hash is what RPC
 * reports for indexed events.
 */
import { FeeBumpTransaction, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { AppError } from '../../middlewares/error.middleware';

export interface BumpPlan {
  outerFee: bigint;
  inclusionPerOp: bigint;
  resourceFee: bigint;
}

export class FeeBumpCapExceeded extends AppError {
  constructor(public readonly outerFee: bigint, public readonly maxStroops: bigint) {
    super(422, 'FEE_BUMP_CAP_EXCEEDED', `fee bump ${outerFee} stroops exceeds cap ${maxStroops}`, {
      outerFee: outerFee.toString(),
      maxStroops: maxStroops.toString(),
    });
    this.name = 'FeeBumpCapExceeded';
  }
}

export class FeeBumpFeeMismatch extends AppError {
  constructor(public readonly sdkFee: bigint, public readonly expected: bigint) {
    super(500, 'FEE_BUMP_FEE_MISMATCH', `SDK fee ${sdkFee} does not match computed ${expected}`, {
      sdkFee: sdkFee.toString(),
      expected: expected.toString(),
    });
    this.name = 'FeeBumpFeeMismatch';
  }
}

/** Soroban resource fee carried by the inner transaction, or 0 for non-Soroban. */
export function innerResourceFee(inner: Transaction): bigint {
  try {
    const ext = inner.toEnvelope().v1().tx().ext();
    if (ext.switch() !== 1) return 0n;
    return BigInt(ext.sorobanData().resourceFee().toString());
  } catch {
    return 0n;
  }
}

/** Inner fee minus its resource fee: the inclusion fee the network bids on. */
export function innerInclusionPerOp(inner: Transaction): bigint {
  const total = BigInt(inner.fee);
  const resource = innerResourceFee(inner);
  const inclusion = total > resource ? total - resource : 0n;
  const ops = BigInt(Math.max(1, inner.operations.length));
  return inclusion / ops;
}

export function planBump(
  inner: Transaction,
  prevInclusionPerOp: bigint,
  opts: { multiplier: number; maxStroops: bigint; feeStatsP90?: bigint },
): BumpPlan {
  const resourceFee = innerResourceFee(inner);
  const innerInclusion = innerInclusionPerOp(inner);
  const multiplier = BigInt(Math.max(1, Math.floor(opts.multiplier)));

  const inclusionPerOp = [prevInclusionPerOp * multiplier, opts.feeStatsP90 ?? 0n, innerInclusion + 1n, 1n].reduce(
    (a, b) => (b > a ? b : a),
  );

  // The fee bump counts as an extra operation: outerFee >= resourceFee + inclusion × (ops + 1).
  const outerFee = resourceFee + inclusionPerOp * BigInt(inner.operations.length + 1);
  if (outerFee > opts.maxStroops) throw new FeeBumpCapExceeded(outerFee, opts.maxStroops);
  return { outerFee, inclusionPerOp, resourceFee };
}

/**
 * Builds the outer transaction with the exact total fee from the plan. The SDK
 * builder only computes `baseFee × (ops + 1)`; the protocol additionally
 * requires the outer fee to cover the inner resource fee, so the total is set
 * explicitly and the builder's base-fee semantics are asserted first.
 */
export function buildFeeBump(inner: Transaction, plan: BumpPlan, feeSource: string, passphrase: string): FeeBumpTransaction {
  const outer = TransactionBuilder.buildFeeBumpTransaction(feeSource, plan.inclusionPerOp.toString(), inner, passphrase);
  const expectedBase = plan.inclusionPerOp * BigInt(inner.operations.length + 1);
  if (BigInt(outer.fee) !== expectedBase) {
    // A future SDK changing base-fee semantics must not silently underpay.
    throw new FeeBumpFeeMismatch(BigInt(outer.fee), expectedBase);
  }
  (outer as { fee: string }).fee = plan.outerFee.toString();
  return outer;
}

export interface FeeBumpSigner {
  signTransaction?: (xdr: string, opts?: { networkPassphrase?: string; address?: string }) => Promise<{ signedTxXdr: string }>;
  keypair?: { signTransaction?: (tx: unknown) => void; publicKey(): string };
}

/** Signs the outer transaction only. The inner signatures are never touched. */
export async function signFeeBump(outer: FeeBumpTransaction, signer: FeeBumpSigner, passphrase: string): Promise<FeeBumpTransaction> {
  if (signer.signTransaction) {
    const signed = await signer.signTransaction(outer.toEnvelope().toXDR('base64'), { networkPassphrase: passphrase });
    return TransactionBuilder.fromXDR(signed.signedTxXdr, passphrase) as FeeBumpTransaction;
  }
  if (signer.keypair) {
    outer.sign(signer.keypair as never);
    return outer;
  }
  throw new AppError(500, 'FEE_BUMP_NO_SIGNER', 'fee payer signer is not configured');
}
