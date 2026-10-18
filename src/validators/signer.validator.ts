import { z } from 'zod';

export const marketParamsSchema = z.object({
  marketId: z.string().uuid('marketId must be a market UUID'),
});

export const prepareBodySchema = z.object({
  outcome: z.enum(['YES', 'NO']),
});

export const prepareQuerySchema = z.object({
  allowConflict: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const submitBodySchema = z.object({
  xdr: z.string().min(1).max(20_000),
});
