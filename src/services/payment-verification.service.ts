/**
 * Verifies a premium payment on-chain: a successful SEP-41 `transfer` on the
 * USDC contract, from the logged-in user, to PAYMENTS_RECIPIENT, for at least
 * the tier price. There is no bypass: if this can't prove the payment, the
 * payment grants nothing. Tests inject a fake RPC client.
 *
 * #46: a login can be a sub-identity of a pooled base account (an M… muxed
 * address, or a G… account with an id memo). Such a payment must additionally
 * prove that sub-identity, or another sub-user of the same pool could claim it.
 */
import { Address, MuxedAccount, rpc, scValToNative, StrKey } from '@stellar/stellar-sdk';
import { AppError } from '../middlewares/error.middleware';
import { rpcServer } from './stellar/clients';
import {
  innerTransaction,
  TransactionReader,
  getTransactionReader,
  setTransactionReader,
} from './stellar/tx-inspect';
import { withTimeout, TimeoutError } from '../lib/resilience';

export { innerTransaction, TransactionReader, setTransactionReader };

export interface TxMemo {
  type: 'none' | 'id' | 'text' | 'hash' | 'return';
  value: string | null;
}

export interface VerifiedTransfer {
  txHash: string;
  /** Base G… account the transfer is from. */
  from: string;
  to: string;
  amount: bigint;
  ledger: number;
  /** Base G… account of the (inner) transaction source. */
  txSource: string;
  memo: TxMemo;
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

  const tx = innerTransaction(response.envelopeXdr);
  const ops = tx.operations();
  if (ops.length !== 1 || ops[0].body().switch().name !== 'invokeHostFunction') {
    throw fail('PAYMENT_WRONG_TOKEN', 'The transaction is not a token transfer');
  }
  const fn = ops[0].body().invokeHostFunctionOp().hostFunction();
  if (fn.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw fail('PAYMENT_WRONG_TOKEN', 'The transaction is not a token transfer');
  }
  const call = fn.invokeContract();
  const contract = Address.fromScAddress(call.contractAddress()).toString();
  const method = call.functionName().toString();
  const args = call.args();
  if (contract !== expected.token || method !== 'transfer' || args.length !== 3) {
    throw fail('PAYMENT_WRONG_TOKEN', 'The transaction is not a USDC transfer', { contract, method });
  }

  const rawFrom = Address.fromScVal(args[0]).toString();
  const to = Address.fromScVal(args[1]).toString();
  const amount = scValToNative(args[2]) as bigint;

  // A Soroban transfer's `from` may be the base account or the muxed address.
  const fromMuxed = parseMuxed(rawFrom);
  const from = fromMuxed ? fromMuxed.base : rawFrom;
  if (from !== expected.from) {
    throw fail('PAYMENT_WRONG_SENDER', 'The payment was not sent from your connected wallet');
  }
  if (to !== expected.to) {
    throw fail('PAYMENT_WRONG_RECIPIENT', 'The payment was sent to the wrong recipient');
  }
  if (typeof amount !== 'bigint' || amount < expected.minAmount) {
    throw fail('PAYMENT_INSUFFICIENT', 'Payment amount is less than the required tier price', {
      expected: expected.minAmount.toString(),
      actual: typeof amount === 'bigint' ? amount.toString() : String(amount),
    });
  }

  const txSource = readTxSource(tx);
  const memo = readMemo(tx);

  // A sub-user of a pooled account must prove which sub-identity paid.
  if (expected.subIdKind === 'MUXED' && expected.subId != null) {
    const fromProves =
      fromMuxed != null && fromMuxed.base === expected.from && fromMuxed.id === expected.subId;
    const sourceProves =
      txSource.muxed && txSource.base === expected.from && txSource.id === expected.subId;
    if (!fromProves && !sourceProves) {
      throw fail('PAYMENT_SUBACCOUNT_UNPROVEN', 'The payment does not prove this muxed sub-account');
    }
  } else if (expected.subIdKind === 'MEMO' && expected.subId != null) {
    if (memo.type !== 'id' || memo.value !== expected.subId) {
      throw fail('PAYMENT_SUBACCOUNT_UNPROVEN', 'The payment does not carry the memo id for this sub-account');
    }
  }

  return {
    txHash: expected.txHash,
    from,
    to,
    amount,
    ledger: response.ledger,
    txSource: txSource.base,
    memo,
  };
}
