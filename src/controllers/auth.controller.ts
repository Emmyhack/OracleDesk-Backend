import type { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.util';
import { createChallenge, verifyChallenge } from '../services/auth.service';

/** POST /auth/challenge — { address, memo? } → challenge transaction */
export async function postChallenge(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await createChallenge(req.body?.address, req.body?.memo));
}

/** POST /auth/verify — { address, signed, memo? } → { token, userId, walletAddress } */
export async function postVerify(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await verifyChallenge(req.body?.address, req.body?.signed, req.body?.memo));
}
