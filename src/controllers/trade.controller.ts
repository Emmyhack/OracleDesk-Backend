import type { Request, Response } from 'express';
import { Account, MuxedAccount } from '@stellar/stellar-sdk';
import { CopyTradeStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { sendSuccess, sendError } from '../utils/response.util';
import { checkAccess } from '../services/subscription.service';
import { CONTRACTS } from '../config/contracts';
import { config } from '../config';
import { toDisplayUsdc } from '../lib/amounts';
import { confirmCopyTradeSchema, copyTradeSchema } from '../validators/trade.validator';
import { confirmCopyTrade as serviceConfirmCopyTrade } from '../services/copy-trade.service';
import { AppError } from '../middlewares/error.middleware';

/**
 * POST /trade/copy
 * Records a subscriber's intent to copy an agent trade and returns what the
 * wallet must sign: market_core.buy on the trace's market and side.
 *
 * The user signs in their own wallet; the backend never trades for them.
 * min_shares_out is not included because it must come from a quote taken
 * right before signing.
 */
export async function initiateCopyTrade(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required to copy-trade');
    return;
  }

  const parsed = copyTradeSchema.safeParse({ body: req.body });
  if (!parsed.success) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid copy-trade parameters',
      parsed.error.flatten().fieldErrors as any);
    return;
  }

  const { traceId, marketId, amountRaw } = parsed.data.body;

  // Rate limiting / row spam prevention: cap open PENDING / CONFIRMING copy trades
  const openCount = await prisma.copyTrade.count({
    where: {
      userId: req.user.userId,
      status: { in: [CopyTradeStatus.PENDING, CopyTradeStatus.CONFIRMING] },
    },
  });
  if (openCount >= config.COPY_TRADE_MAX_PENDING) {
    sendError(
      res,
      429,
      'COPY_TRADE_LIMIT_REACHED',
      `You have ${openCount} unconfirmed copy trades. Complete or wait for them to expire before creating more.`,
    );
    return;
  }

  const access = await checkAccess(req.user.userId, traceId);
  if (!access.hasAccess) {
    sendError(res, 403, 'TRACE_LOCKED', 'Unlock this trace before copying it');
    return;
  }

  const trace = await prisma.reasoningTrace.findUnique({
    where: { id: traceId },
    include: { market: true },
  });
  if (!trace) {
    sendError(res, 404, 'TRACE_NOT_FOUND', 'Reasoning trace not found');
    return;
  }
  if (trace.marketId !== marketId) {
    sendError(res, 400, 'MARKET_MISMATCH', 'traceId and marketId do not match');
    return;
  }

  const market = trace.market;
  if (market.onChainMarketId === null) {
    sendError(res, 409, 'MARKET_NOT_ON_CHAIN', 'This market is not on-chain yet');
    return;
  }
  if (market.status !== 'ACTIVE') {
    sendError(res, 409, 'MARKET_NOT_ACTIVE', 'Market is not active for trading');
    return;
  }
  // No edge means no side to copy. Never default to YES.
  if (!trace.edge) {
    sendError(res, 422, 'NO_EDGE', 'This trace has no edge, so there is no trade to copy');
    return;
  }
  const direction = trace.edge > 0 ? 'YES' : 'NO';
  const expiresAt = new Date(Date.now() + config.COPY_TRADE_TTL_MINUTES * 60 * 1000);

  // #46: a custodial sub-user shares the pooled base account. Return the muxed
  // address so the client can sign from the sub-identity where one exists.
  const userWalletMuxed =
    req.user.subId != null && req.user.subIdKind === 'MUXED'
      ? new MuxedAccount(new Account(req.user.walletAddress, '0'), req.user.subId).accountId()
      : null;

  const copyTrade = await prisma.copyTrade.create({
    data: {
      userId:         req.user.userId,
      followerWallet: req.user.walletAddress,
      traceId,
      marketId,
      outcome:        direction,
      direction,
      amount:         toDisplayUsdc(BigInt(amountRaw)),
      amountRaw,
      status:         CopyTradeStatus.PENDING,
      expiresAt,
    },
  });

  sendSuccess(res, {
    copyTradeId: copyTrade.id,
    expiresAt,
    transactionPayload: {
      contractId:      CONTRACTS.marketCore,
      onChainMarketId: market.onChainMarketId.toString(),
      outcome:         direction === 'YES' ? 'Yes' : 'No',
      collateralInRaw: amountRaw,
      userWallet:      req.user.walletAddress,
      userWalletMuxed,
      traceReference:  trace.ipfsCid,
    },
    instructions: 'Quote, then sign market_core.buy with min_shares_out from the quote. ' +
                  'Then call PATCH /trade/copy/:id/confirm with the transaction hash.',
  }, 200);
}

/**
 * PATCH /trade/copy/:id/confirm
 * Records and verifies the hash of the user's buy transaction on-chain.
 */
export async function confirmCopyTrade(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }

  const id = String(req.params.id);
  const parsed = confirmCopyTradeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'VALIDATION_ERROR', 'txHash is required', parsed.error.flatten().fieldErrors as any);
    return;
  }

  try {
    const updated = await serviceConfirmCopyTrade(
      req.user.userId,
      req.user.walletAddress,
      id,
      parsed.data.txHash,
    );
    sendSuccess(res, updated);
  } catch (err: any) {
    if (err.statusCode === 202 || err.code === 'COPY_TRADE_PENDING') {
      sendSuccess(res, { status: 'CONFIRMING', retryAfterSeconds: 5 }, 202);
      return;
    }
    if (err instanceof AppError) {
      sendError(res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    sendError(res, 500, 'INTERNAL_SERVER_ERROR', err.message || 'Confirmation failed');
  }
}
