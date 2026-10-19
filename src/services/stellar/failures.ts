/**
 * Classification of live-write submission failures (#40).
 *
 * Every live write used to collapse into a single generic `ChainError`. The
 * classes here are decided from the actual XDR result codes Stellar RPC
 * returns, so the retry policy can retry only what is provably safe. The rule
 * is conservative: anything that cannot be proved *not applied* is ambiguous
 * (`UNKNOWN_OUTCOME`) and is never re-submitted with a rebuilt transaction.
 */
import { xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import { contractErrorName } from './errors';
import type { ChainError } from './errors';

export type FailureClass =
  | 'TRANSIENT_RPC'
  | 'BAD_SEQUENCE'
  | 'INSUFFICIENT_FEE'
  | 'EXPIRED'
  | 'RESOURCE_OR_STATE'
  | 'CONTRACT_ERROR'
  | 'AUTH'
  | 'INSUFFICIENT_BALANCE'
  | 'UNKNOWN_OUTCOME'
  | 'UNKNOWN';

export type RetryAction = 'resend' | 'rebuild' | 'resync-rebuild' | 'never';

export interface ClassifiedFailure {
  class: FailureClass;
  /** TransactionResultCode name, e.g. 'txBadSeq'. */
  txCode: string | null;
  /** Operation result code name, e.g. 'invokeHostFunctionResourceLimitExceeded'. */
  opCode: string | null;
  /** Contract error name from contractErrorName(), when the failure is one. */
  contractError: string | null;
  txHash: string | null;
  /** Whether the network may already have applied the envelope. */
  submitted: boolean;
}

export type ContractKey = 'marketCore' | 'treasury' | 'resolver' | 'reasoningRegistry';

/** Per-class reaction. `never` classes are permanent and are never retried. */
export const RETRY_POLICY: Record<FailureClass, RetryAction> = {
  TRANSIENT_RPC: 'rebuild',
  BAD_SEQUENCE: 'resync-rebuild',
  INSUFFICIENT_FEE: 'rebuild',
  EXPIRED: 'rebuild',
  RESOURCE_OR_STATE: 'rebuild',
  CONTRACT_ERROR: 'never',
  AUTH: 'never',
  INSUFFICIENT_BALANCE: 'never',
  UNKNOWN_OUTCOME: 'never',
  UNKNOWN: 'never',
};

const TX_CODE_CLASS: Record<string, FailureClass> = {
  txBadSeq: 'BAD_SEQUENCE',
  txInsufficientFee: 'INSUFFICIENT_FEE',
  txTooLate: 'EXPIRED',
  txTooEarly: 'EXPIRED',
  txBadAuth: 'AUTH',
  txBadAuthExtra: 'AUTH',
  txInsufficientBalance: 'INSUFFICIENT_BALANCE',
  txSorobanInvalid: 'RESOURCE_OR_STATE',
};

const OP_CODE_CLASS: Record<string, FailureClass> = {
  invokeHostFunctionResourceLimitExceeded: 'RESOURCE_OR_STATE',
  invokeHostFunctionEntryArchived: 'RESOURCE_OR_STATE',
  invokeHostFunctionInsufficientRefundableFee: 'RESOURCE_OR_STATE',
  invokeHostFunctionTrapped: 'CONTRACT_ERROR',
};

function decodeResult(input: xdr.TransactionResult | string | undefined): xdr.TransactionResult | undefined {
  if (!input) return undefined;
  if (typeof input === 'string') {
    try {
      return xdr.TransactionResult.fromXDR(input, 'base64');
    } catch {
      return undefined;
    }
  }
  return input;
}

interface Decoded {
  txCode: string | null;
  opCode: string | null;
}

/** txCode from result(), plus the operation-level code for txFailed. */
export function decodeResultCodes(result: xdr.TransactionResult | undefined): Decoded {
  if (!result) return { txCode: null, opCode: null };
  const nameOf = (s: { name?: string } | undefined) => (s && typeof s.name === 'string' ? s.name : null);
  let txCode: string | null;
  try {
    txCode = nameOf(result.result().switch());
  } catch {
    return { txCode: null, opCode: null };
  }
  let opCode: string | null = null;
  if (txCode === 'txFailed') {
    try {
      const op = result.result().results()[0]?.tr();
      const opType = op?.switch().name;
      if (opType === 'invokeHostFunction') {
        opCode = nameOf(op!.invokeHostFunctionResult().switch());
      } else if (opType) {
        opCode = opType;
      }
    } catch {
      opCode = null;
    }
  }
  return { txCode, opCode };
}

function classifyCodes(
  contract: ContractKey,
  codes: Decoded,
  txHash: string | null,
  submitted: boolean,
  err: unknown,
): ClassifiedFailure {
  const contractError = contractErrorName(contract, err);
  const { txCode, opCode } = codes;

  if (txCode === 'txFeeBumpInnerFailed') {
    // Unwrap the inner transaction's result before classifying.
    return { class: 'UNKNOWN', txCode, opCode, contractError, txHash, submitted };
  }
  if (txCode && TX_CODE_CLASS[txCode]) {
    return { class: TX_CODE_CLASS[txCode], txCode, opCode, contractError, txHash, submitted };
  }
  if (txCode === 'txFailed' && opCode) {
    const cls = OP_CODE_CLASS[opCode] ?? (contractError ? 'CONTRACT_ERROR' : 'UNKNOWN');
    return { class: cls, txCode, opCode, contractError, txHash, submitted };
  }
  if (contractError) return { class: 'CONTRACT_ERROR', txCode, opCode, contractError, txHash, submitted };
  return { class: 'UNKNOWN', txCode, opCode, contractError, txHash, submitted };
}

const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']);

function classifyThrown(contract: ContractKey, err: unknown): ClassifiedFailure {
  const anyErr = err as { name?: string; code?: string; message?: string; contractError?: string | null; details?: any };
  const message = anyErr?.message ?? String(err);
  const txHash = (anyErr?.details?.txHash as string | undefined) ?? null;

  if (anyErr?.code === 'BAD_SEQ_RESYNCED' || /bad.?seq|txBadSeq/i.test(message)) {
    return { class: 'BAD_SEQUENCE', txCode: 'txBadSeq', opCode: null, contractError: null, txHash, submitted: false };
  }
  const contractError = anyErr?.contractError ?? contractErrorName(contract, err);
  if (contractError) {
    return { class: 'CONTRACT_ERROR', txCode: null, opCode: null, contractError, txHash, submitted: false };
  }
  if (anyErr?.code === 'UPSTREAM_TIMEOUT' || /timed? ?out|timeout/i.test(anyErr?.name ?? '') || /timed out/i.test(message)) {
    return { class: 'UNKNOWN_OUTCOME', txCode: null, opCode: null, contractError: null, txHash, submitted: true };
  }
  if (anyErr?.code && NETWORK_ERROR_CODES.has(anyErr.code)) {
    return { class: 'TRANSIENT_RPC', txCode: null, opCode: null, contractError: null, txHash, submitted: false };
  }
  return { class: 'UNKNOWN', txCode: null, opCode: null, contractError: null, txHash, submitted: false };
}

export function classifyFailure(input: {
  contract: ContractKey;
  err?: unknown;
  send?: rpc.Api.SendTransactionResponse;
  get?: rpc.Api.GetTransactionResponse;
}): ClassifiedFailure {
  const { contract, err, send, get } = input;

  if (send) {
    const s = send as { status: string; hash?: string; errorResult?: any; errorResultXdr?: string };
    if (s.status === 'TRY_AGAIN_LATER') {
      return { class: 'TRANSIENT_RPC', txCode: null, opCode: null, contractError: null, txHash: s.hash ?? null, submitted: false };
    }
    if (s.status === 'DUPLICATE') {
      return { class: 'UNKNOWN_OUTCOME', txCode: null, opCode: null, contractError: null, txHash: s.hash ?? null, submitted: true };
    }
    if (s.status === 'ERROR') {
      const result = decodeResult(s.errorResult ?? s.errorResultXdr);
      return classifyCodes(contract, decodeResultCodes(result), s.hash ?? null, false, err);
    }
  }

  if (get) {
    const g = get as { status: string; resultXdr?: any };
    if (g.status === 'FAILED') {
      const result = decodeResult(g.resultXdr);
      return classifyCodes(contract, decodeResultCodes(result), null, true, err);
    }
    if (g.status === 'NOT_FOUND') {
      return { class: 'UNKNOWN_OUTCOME', txCode: null, opCode: null, contractError: null, txHash: null, submitted: true };
    }
  }

  return classifyThrown(contract, err);
}

// ─── Backoff ─────────────────────────────────────────────────────────────────

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  deadlineMs: number;
}

/**
 * Jittered exponential backoff: `min(maxDelay, base × 2^attempt) × U(0.5, 1)`.
 * The random source is injectable so tests are deterministic.
 */
export function backoffDelay(attempt: number, opts: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>, random: () => number = Math.random): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  const jitter = 0.5 + random() / 2;
  return Math.floor(exp * jitter);
}

/**
 * Whether to retry, and after how long. Enforces the safety rule that an
 * ambiguous outcome (the network may have applied the envelope) is never
 * re-submitted with a rebuilt transaction, regardless of class.
 */
export function retryDecision(
  failure: ClassifiedFailure,
  attempt: number,
  opts: RetryOptions,
  elapsedMs: number,
  random: () => number = Math.random,
): { retry: boolean; delayMs: number } {
  if (RETRY_POLICY[failure.class] === 'never') return { retry: false, delayMs: 0 };
  if (failure.submitted) return { retry: false, delayMs: 0 };
  if (attempt + 1 >= opts.maxAttempts) return { retry: false, delayMs: 0 };
  const delayMs = backoffDelay(attempt, opts, random);
  if (elapsedMs + delayMs > opts.deadlineMs) return { retry: false, delayMs };
  return { retry: true, delayMs };
}

/** Classes that are permanent: the same intent can never succeed unchanged. */
const PERMANENT: ReadonlySet<FailureClass> = new Set(['CONTRACT_ERROR', 'AUTH', 'INSUFFICIENT_BALANCE', 'UNKNOWN']);

export function isPermanentFailure(cls: FailureClass): boolean {
  return PERMANENT.has(cls);
}

/** Error the retry loop throws so the caller sees the structured failure. */
export class ChainWriteFailure extends Error {
  constructor(
    public readonly failure: ClassifiedFailure,
    public readonly cause?: unknown,
  ) {
    super(`chain write failed: ${failure.class}`);
    this.name = 'ChainWriteFailure';
  }
}

export function isChainError(err: unknown): err is ChainError {
  return Boolean(err && typeof (err as { code?: unknown }).code === 'string' && (err as { name?: string }).name === 'ChainError');
}

