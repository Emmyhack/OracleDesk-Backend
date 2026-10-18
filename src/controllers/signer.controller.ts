import type { Request, Response } from 'express';
import { AppError } from '../middlewares/error.middleware';
import { buildPaginationMeta, parsePagination, sendSuccess } from '../utils/response.util';
import {
  marketParamsSchema,
  prepareBodySchema,
  prepareQuerySchema,
  submitBodySchema,
} from '../validators/signer.validator';
import {
  getEvidence,
  getProgress,
  listAwaiting,
  prepareAttestation,
  submitAttestation,
} from '../services/signer-portal.service';

function wallet(req: Request): string {
  if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return req.user.walletAddress;
}

function parse<T>(result: { success: true; data: T } | { success: false; error: { flatten(): { fieldErrors: unknown } } }, message: string): T {
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', message, result.error.flatten().fieldErrors as Record<string, unknown>);
  }
  return result.data;
}

const marketId = (req: Request): string =>
  parse(marketParamsSchema.safeParse(req.params), 'Invalid market id').marketId;

/** GET /signer/markets */
export async function listSignerMarkets(req: Request, res: Response): Promise<void> {
  const { page, limit } = parsePagination(req.query as Record<string, unknown>);
  const { items, total } = await listAwaiting(wallet(req), { page, limit });
  sendSuccess(res, items, 200, buildPaginationMeta(page, limit, total) as unknown as Record<string, unknown>);
}

/** GET /signer/markets/:marketId/evidence */
export async function signerEvidence(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await getEvidence(marketId(req), wallet(req)));
}

/** POST /signer/markets/:marketId/attest/prepare */
export async function prepareSignerAttestation(req: Request, res: Response): Promise<void> {
  const id = marketId(req);
  const { outcome } = parse(prepareBodySchema.safeParse(req.body), 'outcome must be YES or NO');
  const { allowConflict } = parse(prepareQuerySchema.safeParse(req.query), 'allowConflict must be true or false');
  sendSuccess(res, await prepareAttestation(id, wallet(req), outcome, { allowConflict }));
}

/** POST /signer/markets/:marketId/attest/submit */
export async function submitSignerAttestation(req: Request, res: Response): Promise<void> {
  const id = marketId(req);
  const { xdr } = parse(submitBodySchema.safeParse(req.body), 'xdr is required');
  const result = await submitAttestation(id, wallet(req), xdr);
  // 202: broadcast, not yet seen in a ledger. Poll /progress.
  sendSuccess(res, result, result.status === 'CONFIRMED' ? 200 : 202);
}

/** GET /signer/markets/:marketId/progress */
export async function signerProgress(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await getProgress(marketId(req), wallet(req)));
}
