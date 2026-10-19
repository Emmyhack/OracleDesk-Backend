/**
 * Verifies a premium payment on-chain: a successful SEP-41 `transfer` on the
 * USDC contract, from the logged-in user, to PAYMENTS_RECIPIENT, for at least
 * the tier price. There is no bypass: if this can't prove the payment, the
 * payment grants nothing. Tests inject a fake RPC client.
 *
 * #51: the source of truth is the SAC `transfer` events the token contract
 * actually emitted, decoded from the transaction meta. The envelope is only a
 * secondary invariant for a simple direct call.
 *
 * #46: a login can be a sub-identity of a pooled base account (an M… muxed
 * address, or a G… account with an id memo). Such a payment must additionally
 * prove that sub-identity, or another sub-user of the same pool could claim it.
 */
import { Address, MuxedAccount, rpc, scValToNative, StrKey, xdr } from '@stellar/stellar-sdk';
import { AppError } from '../middlewares/error.middleware';
import { logger } from '../lib/logger';
import { rpcServer } from './stellar/clients';
import {
  innerTransaction,
  TransactionReader,
  getTransactionReader,
  setTransactionReader,
} from './stellar/tx-inspect';
import { sacTransfersFromMeta, SacTransfer } from './stellar/sac-events';
import { withTimeout, TimeoutError } from '../lib/resilience';

export { innerTransaction, TransactionReader, setTransactionReader };

export interface TxMemo {
  type: 'none' | 'id' | 'text' | 'hash' | 'return';
  value: string | null;
}

export interface VerifiedTransfer {
  txHash: string;
  /** Base G…/C… account the transfer is from. */
  from: string;
  to: string;
  amount: bigint;
  ledger: number;
  /** Base G… account of the (inner) transaction source. */
  txSource: string;
  memo: TxMemo;
  /** Qualifying transfers (from → to) that were summed. */
  transfers: SacTransfer[];
  /** Recipient muxed id from a CAP-67 transfer, when present. */
  toMuxedId: string | null;
  createdAt: number | null;
  /** Set when a single direct-call envelope disagreed with the events. */
  envelopeMismatch: boolean;
}

export interface ExpectedTransfer {
  txHash: string;
  token: string;
  from: string;
  to: string;
  minAmount: bigint;
  /** Sub-identity id (muxed or memo) that the payment must prove, if any. */
  subId?: string | null;
  subIdKind?: 'MUXED' | 'MEMO' | null;
  /** Exact transaction memo required by a payment intent (#52). */
  memo?: { type: 'id' | 'text'; value: string } | null;
}

const fail = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(402, code, message, details);

interface MuxedParts {
  base: string;
  id: string;
}

/** Parses an M… address into its base account and id, or null if not muxed. */
function parseMuxed(address: string): MuxedParts | null {
  if (!StrKey.isValidMed25519PublicKey(address)) return null;
  try {
    const muxed = MuxedAccount.fromAddress(address, '0');
    return { base: muxed.baseAccount().accountId(), id: muxed.id() };
  } catch {
    return null;
  }
}

/** The inner transaction's source account, unwrapping any muxed form. */
function readTxSource(tx: ReturnType<typeof innerTransaction>): MuxedParts & { muxed: boolean } {
  const source = tx.sourceAccount();
  if (source.switch().name === 'keyTypeMuxedEd25519') {
    const m = source.med25519();
    return { base: StrKey.encodeEd25519PublicKey(m.ed25519()), id: m.id().toString(), muxed: true };
  }
  return { base: StrKey.encodeEd25519PublicKey(source.ed25519()), id: '0', muxed: false };
}

/** Reads the inner transaction memo into a stable shape. */
function readMemo(tx: ReturnType<typeof innerTransaction>): TxMemo {
  try {
    const memo = tx.memo();
    switch (memo.switch().name) {
      case 'memoId':
        return { type: 'id', value: memo.id().toString() };
      case 'memoText':
        return { type: 'text', value: memo.text().toString() };
      case 'memoHash':
        return { type: 'hash', value: memo.hash().toString('hex') };
      case 'memoReturn':
        return { type: 'return', value: memo.retHash().toString('hex') };
      default:
        return { type: 'none', value: null };
    }
  } catch {
    return { type: 'none', value: null };
  }
}

/** The recipient/amount a single direct-call envelope requested, if any. */
interface DirectCall {
  contract: string;
  from: string;
  to: string;
  amount: bigint;
  rawFrom: string;
}

/** Reads a single direct `transfer` invocation from the envelope, or null. */
function readDirectTransfer(tx: ReturnType<typeof innerTransaction>): DirectCall | null {
  try {
    const ops = tx.operations();
    if (ops.length !== 1 || ops[0].body().switch().name !== 'invokeHostFunction') return null;
    const fn = ops[0].body().invokeHostFunctionOp().hostFunction();
    if (fn.switch().name !== 'hostFunctionTypeInvokeContract') return null;
    const call = fn.invokeContract();
    const method = call.functionName().toString();
    const args = call.args();
    if (method !== 'transfer' || args.length !== 3) return null;
    const contract = Address.fromScAddress(call.contractAddress()).toString();
    const rawFrom = Address.fromScVal(args[0]).toString();
    const to = Address.fromScVal(args[1]).toString();
    const amount = scValToNative(args[2]) as bigint;
    if (typeof amount !== 'bigint') return null;
    const fromMuxed = parseMuxed(rawFrom);
    return { contract, from: fromMuxed ? fromMuxed.base : rawFrom, to, amount, rawFrom };
  } catch {
    return null;
  }
}

export async function verifyUsdcTransfer(
  expected: ExpectedTransfer,
  signal?: AbortSignal,
): Promise<VerifiedTransfer> {
  if (!/^[0-9a-f]{64}$/.test(expected.txHash)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'txHash must be a 64-character lowercase hex Stellar transaction hash');
  }

  let response: rpc.Api.GetTransactionResponse;
  try {
    response = await withTimeout(
      'rpc-read',
      async () => getTransactionReader().getTransaction(expected.txHash),
      { signal },
    );
  } catch (err: any) {
    if (err instanceof TimeoutError || err?.code === 'UPSTREAM_TIMEOUT') {
      throw new AppError(502, 'CHAIN_READ_FAILED', 'Stellar RPC read timed out', { timeout: true });
    }
    throw new AppError(502, 'CHAIN_READ_FAILED', 'Could not reach Stellar RPC to verify the payment', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw fail('PAYMENT_NOT_FOUND', 'Payment transaction not found. If you just paid, wait a few seconds and retry.');
  }
  if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw fail('PAYMENT_FAILED', 'The payment transaction failed on-chain');
  }

  const anyResponse = response as any;
  const resultMetaXdr = anyResponse.resultMetaXdr as xdr.TransactionMeta | string | undefined;
  const contractEventsXdr = anyResponse.events?.contractEventsXdr as xdr.ContractEvent[][] | undefined;
  const hasContractEvents = Array.isArray(contractEventsXdr) && contractEventsXdr.some((ops) => Array.isArray(ops) && ops.length > 0);

  // Fail closed: never fall back to envelope-only verification when the node
  // did not return the meta that records value movement.
  if (!resultMetaXdr && !hasContractEvents) {
    throw new AppError(502, 'CHAIN_READ_INCOMPLETE', 'Stellar RPC returned no transaction meta; cannot verify the payment');
  }

  const allTransfers = sacTransfersFromMeta({ resultMetaXdr, contractEventsXdr });
  const transfers = allTransfers.filter((t) => t.contractId === expected.token);
  if (transfers.length === 0) {
    throw fail('PAYMENT_WRONG_TOKEN', 'No transfer of the expected token in this transaction', {
      contract: expected.token,
    });
  }

  const matching = transfers.filter((t) => t.from === expected.from && t.to === expected.to);
  if (matching.length === 0) {
    if (!transfers.some((t) => t.to === expected.to)) {
      throw fail('PAYMENT_WRONG_RECIPIENT', 'The payment was sent to the wrong recipient');
    }
    throw fail('PAYMENT_WRONG_SENDER', 'The payment was not sent from your connected wallet');
  }

  const paid = matching.reduce((sum, t) => sum + t.amount, 0n);
  const refunded = transfers
    .filter((t) => t.from === expected.to && t.to === expected.from)
    .reduce((sum, t) => sum + t.amount, 0n);
  const net = paid - refunded;
  if (net < expected.minAmount) {
    throw fail('PAYMENT_INSUFFICIENT', 'Payment amount is less than the required tier price', {
      paidRaw: paid.toString(),
      refundedRaw: refunded.toString(),
      netRaw: net.toString(),
      requiredRaw: expected.minAmount.toString(),
    });
  }

  // Envelope reads are best-effort: the events above already proved the
  // payment. The envelope only supplies secondary signals (memo, source) and
  // the direct-call invariant.
  let tx: ReturnType<typeof innerTransaction> | null = null;
  try {
    tx = innerTransaction(response.envelopeXdr);
  } catch {
    tx = null;
  }

  const txSource = tx ? readTxSource(tx) : { base: expected.from, id: '0', muxed: false };
  const memo = tx ? readMemo(tx) : { type: 'none' as const, value: null };
  const direct = tx ? readDirectTransfer(tx) : null;

  // Secondary invariant: for a simple direct `transfer` call the envelope must
  // agree with the events. The events are authoritative, so a disagreement is
  // logged (and surfaced to callers) but never rejects an events-proven
  // payment: an honest network cannot produce one, and failing here would
  // reintroduce the envelope-first behaviour #51 removes.
  let envelopeMismatch = false;
  if (direct && direct.contract === expected.token) {
    envelopeMismatch =
      direct.from !== expected.from ||
      direct.to !== expected.to ||
      direct.amount !== paid;
    if (envelopeMismatch) {
      logger.error(
        {
          txHash: expected.txHash,
          envelope: { from: direct.from, to: direct.to, amount: direct.amount.toString() },
          events: matching.map((t) => ({ from: t.from, to: t.to, amount: t.amount.toString() })),
        },
        'Payment envelope disagrees with SAC transfer events; trusting the events',
      );
    }
  }

  if (expected.memo) {
    if (memo.type !== expected.memo.type || memo.value !== expected.memo.value) {
      throw fail('PAYMENT_MEMO_MISMATCH', 'The payment memo does not match this payment intent', {
        expectedType: expected.memo.type,
        expectedValue: expected.memo.value,
        actualType: memo.type,
        actualValue: memo.value,
      });
    }
  }

  // A sub-user of a pooled account must prove which sub-identity paid.
  if (expected.subIdKind === 'MUXED' && expected.subId != null) {
    const directMuxed = direct ? parseMuxed(direct.rawFrom) : null;
    const fromProves = directMuxed != null && directMuxed.base === expected.from && directMuxed.id === expected.subId;
    const sourceProves = txSource.muxed && txSource.base === expected.from && txSource.id === expected.subId;
    const eventProves = matching.some((t) => t.toMuxedId === expected.subId);
    if (!fromProves && !sourceProves && !eventProves) {
      throw fail('PAYMENT_SUBACCOUNT_UNPROVEN', 'The payment does not prove this muxed sub-account');
    }
  } else if (expected.subIdKind === 'MEMO' && expected.subId != null) {
    if (memo.type !== 'id' || memo.value !== expected.subId) {
      throw fail('PAYMENT_SUBACCOUNT_UNPROVEN', 'The payment does not carry the memo id for this sub-account');
    }
  }

  const toMuxedId = matching.find((t) => t.toMuxedId != null)?.toMuxedId ?? null;

  return {
    txHash: expected.txHash,
    from: expected.from,
    to: expected.to,
    amount: net,
    ledger: response.ledger,
    txSource: txSource.base,
    memo,
    transfers: matching,
    toMuxedId,
    createdAt: typeof anyResponse.createdAt === 'number' ? anyResponse.createdAt : null,
    envelopeMismatch,
  };
}
