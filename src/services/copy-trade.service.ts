import { CopyTradeStatus, Prisma } from '@prisma/client';
import { Address, rpc } from '@stellar/stellar-sdk';
import { prisma as defaultPrisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { CONTRACTS } from '../config/contracts';
import { toDisplayUsdc } from '../lib/amounts';
import { AppError } from '../middlewares/error.middleware';
import { withTimeout, TimeoutError } from '../lib/resilience';
import {
  innerTransaction,
  readContractEvents,
  getTransactionReader,
  TransactionReader,
} from './stellar/tx-inspect';
import type { DecodedEvent } from './indexer.service';
import { notifyUser } from '../lib/socket-auth';

export { CopyTradeStatus };

/**
 * COPY_TRADE_CONFIRMED to the owner's sockets (#94). `verified` is true when
 * the buy was matched to an on-chain Trade event, which is how every path that
 * sets EXECUTED works today. Call this after the status update, never inside
 * a transaction.
 */
export function notifyCopyTradeConfirmed(
  copyTrade: { id: string; userId?: string | null; txHash?: string | null; status: string },
  verified: boolean,
): void {
  if (!copyTrade.userId) return;
  notifyUser(copyTrade.userId, 'COPY_TRADE_CONFIRMED', {
    copyTradeId: copyTrade.id,
    txHash: copyTrade.txHash ?? null,
    status: copyTrade.status,
    verified,
  });
}

export class CopyTradePendingError extends AppError {
  constructor(message = 'Transaction not confirmed on-chain yet') {
    super(202, 'COPY_TRADE_PENDING', message, { retryAfterSeconds: 5 });
  }
}

export interface VerifiedCopyTrade {
  txHash: string;
  ledger: number;
  trader: string;
  onChainMarketId: bigint;
  outcome: 'Yes' | 'No';
  collateral: bigint;
  shares: bigint;
  fee: bigint;
  eventId: string;
}

export interface ExpectedCopyTrade {
  txHash: string;
  trader: string;
  onChainMarketId: bigint;
  outcome: 'Yes' | 'No';
  maxCollateral: bigint;
}

function parseOutcome(o: unknown): 'Yes' | 'No' | null {
  if (o === 'Yes' || o === 'No') return o;
  if (o && typeof o === 'object' && 'tag' in o) {
    const tag = (o as any).tag;
    if (tag === 'Yes' || tag === 'No') return tag;
  }
  return null;
}

function normalizeAddress(addr: string): string {
  try {
    return Address.fromString(addr).toString();
  } catch {
    return addr.trim().toUpperCase();
  }
}

/**
 * Verifies a copy-trade transaction against on-chain status, contract events, and envelope.
 */
export async function verifyCopyTradeTx(
  expected: ExpectedCopyTrade,
  customReader?: TransactionReader,
  signal?: AbortSignal,
): Promise<VerifiedCopyTrade> {
  const txHash = expected.txHash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'txHash must be a 64-character lowercase hex string');
  }

  const reader = customReader ?? getTransactionReader();
  let response: rpc.Api.GetTransactionResponse;

  try {
    response = await withTimeout(
      'rpc-read',
      async () => reader.getTransaction(txHash),
      { signal },
    );
  } catch (err: any) {
    if (err instanceof TimeoutError || err?.code === 'UPSTREAM_TIMEOUT') {
      throw new AppError(502, 'CHAIN_READ_FAILED', 'Stellar RPC read timed out', { timeout: true });
    }
    throw new AppError(502, 'CHAIN_READ_FAILED', 'Could not reach Stellar RPC to verify copy trade', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new CopyTradePendingError();
  }

  if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new AppError(422, 'COPY_TRADE_TX_FAILED', 'Transaction failed on-chain');
  }

  // Primary verification evidence: Contract Events
  const parsedEvents = readContractEvents(response);
  const tradeEvents = parsedEvents.filter(
    (ev) =>
      (ev.name === 'Trade' || ev.name === 'trade') &&
      ev.contractId.toLowerCase() === CONTRACTS.marketCore.toLowerCase(),
  );

  if (tradeEvents.length === 0) {
    throw new AppError(422, 'COPY_TRADE_NO_TRADE_EVENT', 'Transaction did not emit a Trade event');
  }

  const expectedTraderNorm = normalizeAddress(expected.trader);

  // Check market
  const marketEvents = tradeEvents.filter((ev) => {
    try {
      return BigInt(ev.data.market_id) === expected.onChainMarketId;
    } catch {
      return false;
    }
  });
  if (marketEvents.length === 0) {
    throw new AppError(422, 'COPY_TRADE_WRONG_MARKET', 'Trade was executed on a different market');
  }

  // Check trader
  const traderEvents = marketEvents.filter(
    (ev) => normalizeAddress(ev.data.trader) === expectedTraderNorm,
  );
  if (traderEvents.length === 0) {
    throw new AppError(422, 'COPY_TRADE_WRONG_TRADER', 'Trade was executed by a different wallet');
  }

  // Check buy direction
  const buyEvents = traderEvents.filter((ev) => Boolean(ev.data.is_buy));
  if (buyEvents.length === 0) {
    throw new AppError(422, 'COPY_TRADE_NOT_A_BUY', 'Trade was a sell, not a buy');
  }

  // Check outcome side
  const sideEvents = buyEvents.filter((ev) => parseOutcome(ev.data.outcome) === expected.outcome);
  if (sideEvents.length === 0) {
    throw new AppError(422, 'COPY_TRADE_WRONG_SIDE', 'Trade outcome does not match requested outcome');
  }

  // Multi-buy disambiguation: reject if multiple matching events exist for the user
  if (sideEvents.length > 1) {
    throw new AppError(
      422,
      'COPY_TRADE_AMBIGUOUS_EVENTS',
      'Transaction contains multiple matching Trade events for user',
    );
  }

  const matched = sideEvents[0];
  const collateral = BigInt(matched.data.collateral);
  if (collateral > expected.maxCollateral) {
    throw new AppError(
      422,
      'COPY_TRADE_AMOUNT_EXCEEDED',
      `Executed collateral (${collateral}) exceeds maximum approved amount (${expected.maxCollateral})`,
    );
  }

  // Defence-in-depth: check transaction envelope if present
  if (response.envelopeXdr) {
    try {
      const tx = innerTransaction(response.envelopeXdr);
      const ops = tx.operations();
      if (ops.length === 1) {
        const op = ops[0].body();
        if (op.switch().name === 'invokeHostFunction') {
          const hf = op.invokeHostFunctionOp().hostFunction();
          if (hf.switch().name === 'hostFunctionTypeInvokeContract') {
            const call = hf.invokeContract();
            const calledContract = Address.fromScAddress(call.contractAddress()).toString();
            const fnName = call.functionName().toString();

            // If direct call to marketCore.buy, check trader argument
            if (
              calledContract.toLowerCase() === CONTRACTS.marketCore.toLowerCase() &&
              fnName === 'buy'
            ) {
              const args = call.args();
              if (args.length > 0) {
                const traderArg = Address.fromScVal(args[0]).toString();
                if (normalizeAddress(traderArg) !== expectedTraderNorm) {
                  throw new AppError(
                    422,
                    'COPY_TRADE_WRONG_TRADER',
                    'Direct contract invocation trader does not match wallet',
                  );
                }
              }
            }
            // Smart wallet routing (e.g. C... account or account proxy):
            // envelope check skipped; event authorization check above is authoritative.
          }
        }
      }
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      // Other envelope parsing issues do not reject if event was valid
    }
  }

  return {
    txHash,
    ledger: response.ledger,
    trader: expected.trader,
    onChainMarketId: expected.onChainMarketId,
    outcome: expected.outcome,
    collateral,
    shares: BigInt(matched.data.shares),
    fee: BigInt(matched.data.fee ?? 0),
    eventId: response.txHash,
  };
}

/**
 * Confirms a copy trade on-chain.
 * Updates state to EXECUTED on success, or CONFIRMING if still pending.
 */
export async function confirmCopyTrade(
  userId: string,
  wallet: string,
  copyTradeId: string,
  txHashRaw: string,
  prisma = defaultPrisma,
): Promise<any> {
  const txHash = txHashRaw.toLowerCase();

  const copyTrade = await prisma.copyTrade.findFirst({
    where: {
      id: copyTradeId,
      followerWallet: wallet,
    },
    include: {
      market: { select: { onChainMarketId: true } },
    },
  });

  if (!copyTrade) {
    throw new AppError(404, 'COPY_TRADE_NOT_FOUND', 'Copy trade not found');
  }

  // Idempotent return if already executed with identical txHash
  if (copyTrade.status === CopyTradeStatus.EXECUTED) {
    if (copyTrade.txHash?.toLowerCase() === txHash) {
      return copyTrade;
    }
    throw new AppError(
      409,
      'COPY_TRADE_ALREADY_CONFIRMED',
      'Copy trade is already confirmed with another transaction',
    );
  }

  if (
    copyTrade.status !== CopyTradeStatus.PENDING &&
    copyTrade.status !== CopyTradeStatus.CONFIRMING
  ) {
    throw new AppError(
      400,
      'COPY_TRADE_INVALID_STATE',
      `Cannot confirm copy trade in ${copyTrade.status} status`,
    );
  }

  // Check if txHash has already been consumed by another copy trade
  const duplicate = await prisma.copyTrade.findFirst({
    where: {
      txHash,
      id: { not: copyTradeId },
    },
  });
  if (duplicate) {
    throw new AppError(
      409,
      'COPY_TRADE_TX_ALREADY_USED',
      'This transaction has already confirmed another copy trade',
    );
  }

  if (!copyTrade.market?.onChainMarketId) {
    throw new AppError(400, 'MARKET_NOT_ON_CHAIN', 'Market is not active on-chain');
  }

  const expectedOutcome: 'Yes' | 'No' = (copyTrade as any).outcome === 'YES' ? 'Yes' : 'No';
  const maxCollateral = BigInt(copyTrade.amountRaw ?? '0');

  try {
    const verified = await verifyCopyTradeTx({
      txHash,
      trader: wallet,
      onChainMarketId: copyTrade.market.onChainMarketId,
      outcome: expectedOutcome,
      maxCollateral,
    });

    const updated = await prisma.copyTrade.update({
      where: { id: copyTradeId },
      data: {
        txHash,
        status: CopyTradeStatus.EXECUTED,
        collateralRaw: verified.collateral.toString(),
        sharesRaw: verified.shares.toString(),
        feeRaw: verified.fee.toString(),
        ledger: verified.ledger,
        chainEventId: verified.eventId,
        confirmedAt: new Date(),
        amount: toDisplayUsdc(verified.collateral),
        failureCode: null,
      },
    });

    notifyCopyTradeConfirmed({ ...updated, userId: updated.userId ?? copyTrade.userId }, true);
    return updated;
  } catch (err: any) {
    if (err instanceof CopyTradePendingError) {
      // Mark as CONFIRMING
      await prisma.copyTrade.update({
        where: { id: copyTradeId },
        data: {
          txHash,
          status: CopyTradeStatus.CONFIRMING,
          verificationAttempts: { increment: 1 },
        },
      });
      throw err;
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(
        409,
        'COPY_TRADE_TX_ALREADY_USED',
        'This transaction has already confirmed another copy trade',
      );
    }

    // Definitive validation errors -> mark FAILED
    if (err instanceof AppError && err.statusCode === 422) {
      await prisma.copyTrade.update({
        where: { id: copyTradeId },
        data: {
          txHash,
          status: CopyTradeStatus.FAILED,
          failureCode: err.code,
        },
      });
    }

    throw err;
  }
}

/**
 * Reconciles pending copy trades directly from a decoded on-chain Trade event.
 */
export async function reconcileFromTradeEvent(
  event: DecodedEvent,
  prisma = defaultPrisma,
): Promise<'confirmed' | 'ignored'> {
  const p = event.params;
  if (!Boolean(p.is_buy)) return 'ignored';

  const txHash = event.txHash.toLowerCase();
  const onChainMarketId = BigInt(p.market_id);
  const trader = normalizeAddress(p.trader);
  const outcome = parseOutcome(p.outcome);
  if (!outcome) return 'ignored';

  const targetOutcome = outcome === 'Yes' ? 'YES' : 'NO';

  const copyTrade = await prisma.copyTrade.findFirst({
    where: {
      txHash,
      status: { in: [CopyTradeStatus.PENDING, CopyTradeStatus.CONFIRMING] },
      followerWallet: trader,
      outcome: targetOutcome,
      market: { onChainMarketId },
    },
  });

  if (!copyTrade) return 'ignored';

  const collateral = BigInt(p.collateral);
  const maxCollateral = BigInt(copyTrade.amountRaw ?? '0');

  if (maxCollateral > 0n && collateral > maxCollateral) {
    await prisma.copyTrade.update({
      where: { id: copyTrade.id },
      data: {
        status: CopyTradeStatus.FAILED,
        failureCode: 'COPY_TRADE_AMOUNT_EXCEEDED',
      },
    });
    return 'ignored';
  }

  const confirmed = await prisma.copyTrade.update({
    where: { id: copyTrade.id },
    data: {
      status: CopyTradeStatus.EXECUTED,
      collateralRaw: collateral.toString(),
      sharesRaw: p.shares ? String(p.shares) : null,
      feeRaw: p.fee ? String(p.fee) : '0',
      ledger: event.ledger,
      chainEventId: event.id,
      confirmedAt: new Date(event.ledgerClosedAt),
      amount: toDisplayUsdc(collateral),
      failureCode: null,
    },
  });
  notifyCopyTradeConfirmed({ ...confirmed, userId: confirmed?.userId ?? copyTrade.userId }, true);

  logger.info({ copyTradeId: copyTrade.id, txHash }, 'Reconciled copy trade from on-chain event');
  return 'confirmed';
}

/**
 * Expires pending and confirming copy trades that have passed expiresAt.
 */
export async function expireStaleCopyTrades(
  now = new Date(),
  prisma = defaultPrisma,
): Promise<number> {
  const { count } = await prisma.copyTrade.updateMany({
    where: {
      status: { in: [CopyTradeStatus.PENDING, CopyTradeStatus.CONFIRMING] },
      expiresAt: { lt: now },
    },
    data: {
      status: CopyTradeStatus.EXPIRED,
      failureCode: 'EXPIRED',
    },
  });

  if (count > 0) {
    logger.info({ count }, 'Expired stale unconfirmed copy trades');
  }
  return count;
}
