import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendError, sendSuccess } from '../utils/response.util';
import {
  createChallenge,
  createPowSalt,
  verifyChallenge,
} from '../services/auth.service';
import { createContractChallenge, verifyContractChallenge } from '../services/sep45.service';
import { signToken } from '../middlewares/auth.middleware';

const challengeSchema = z.object({
  address: z.string().min(1),
  memo: z.union([z.string(), z.number()]).optional(),
  pow: z
    .object({ nonce: z.string().min(1), salt: z.string().min(1) })
    .optional(),
});

const verifySchema = z.object({
  address: z.string().min(1),
  signed: z.string().min(1),
  memo: z.union([z.string(), z.number()]).optional(),
});

const contractChallengeSchema = z.object({
  account: z.string().min(1),
  home_domain: z.string().min(1).optional(),
});

const contractVerifySchema = z.object({
  authorization_entries: z.string().min(1).max(16 * 1024),
});

function invalid(res: Response, error: z.ZodError): void {
  sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body', error.flatten().fieldErrors as Record<string, unknown>);
}

/** POST /auth/challenge — { address, memo?, pow? } → challenge transaction */
export async function postChallenge(req: Request, res: Response): Promise<void> {
  const parsed = challengeSchema.safeParse(req.body);
  if (!parsed.success) {
    invalid(res, parsed.error);
    return;
  }
  const result = await createChallenge(parsed.data.address, parsed.data.memo, {
    ip: req.ip,
    pow: parsed.data.pow ?? null,
  });
  if (result.pow) res.setHeader('X-Auth-PoW', `bits=${result.pow.bits}; salt=${result.pow.salt}`);
  sendSuccess(res, result);
}

/** POST /auth/verify — { address, signed, memo? } → { token, userId, walletAddress } */
export async function postVerify(req: Request, res: Response): Promise<void> {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    invalid(res, parsed.error);
    return;
  }
  sendSuccess(
    res,
    await verifyChallenge(parsed.data.address, parsed.data.signed, parsed.data.memo),
  );
}

/**
 * POST /auth/refresh — issue a new access token without a new wallet proof.
 * auth_time is copied from the current token, never reset, so a refresh cannot
 * upgrade an old session past an admin step-up check (#49).
 */
export async function postRefresh(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    sendError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }
  const user = req.user;
  sendSuccess(res, {
    token: signToken(user.userId, user.walletAddress, {
      account: user.account,
      subId: user.subId,
      subIdKind: user.subIdKind,
      accountType: user.accountType,
      authTime: user.auth_time ?? user.iat,
    }),
    userId: user.userId,
    walletAddress: user.walletAddress,
  });
}

/** GET /auth/challenge/pow — single-use salt for the hashcash-style PoW. */
export async function getPowChallenge(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await createPowSalt());
}

/** GET /auth/contract/challenge — SEP-45 authorization entries (#47). */
export async function getContractChallenge(req: Request, res: Response): Promise<void> {
  const parsed = contractChallengeSchema.safeParse(req.query);
  if (!parsed.success) {
    invalid(res, parsed.error);
    return;
  }
  sendSuccess(res, await createContractChallenge(parsed.data.account, parsed.data.home_domain));
}

/** POST /auth/contract/verify — signed SEP-45 entries → a JWT (#47). */
export async function postContractVerify(req: Request, res: Response): Promise<void> {
  const parsed = contractVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    invalid(res, parsed.error);
    return;
  }
  sendSuccess(res, await verifyContractChallenge(parsed.data.authorization_entries));
}
