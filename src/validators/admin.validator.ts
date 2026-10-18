import { z } from 'zod';

const rawAmount = z.string().regex(/^\d+$/, 'must be an integer in 7-decimal base units');
const address = z.string().min(1);
const u64 = z.string().regex(/^\d+$/, 'must be a decimal u64');

export const adminOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('treasury.set_paused'), paused: z.boolean() }),
  z.object({ kind: z.literal('treasury.withdraw'), to: address, amountRaw: rawAmount }),
  z.object({ kind: z.literal('treasury.deposit'), from: address, amountRaw: rawAmount }),
  z.object({ kind: z.literal('treasury.collect_market_fees'), onChainMarketId: u64 }),
  z.object({ kind: z.literal('market_core.set_paused'), paused: z.boolean() }),
]);

export const createOperationSchema = z.object({
  operation: adminOpSchema,
  force: z.boolean().optional(),
});

export const signatureSchema = z.object({
  signedXdr: z.string().min(1),
});

export const recordSchema = z.object({
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex transaction hash'),
});

export const reconcileRunSchema = z.object({
  dryRun: z.boolean().optional(),
  maxMarkets: z.number().int().min(1).max(5000).optional(),
});

export type AdminOpInput = z.infer<typeof adminOpSchema>;

export const controlScopeSchema = z.enum(['ALL', 'MARKET_MAKER', 'TRADER']);

export const pauseAgentSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  until: z.iso.datetime().optional(),
});

export const resumeAgentSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
