import { Router } from 'express';
import {
  listMarkets,
  getMarket,
  getMarketByOnChainId,
  getOnChainMarketState,
  triggerMarketGeneration,
  getMarketGenerationStatus,
} from '../controllers/market.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';
import { generateLimiter } from '../middlewares/rate-limit.middleware';
import { idempotent } from '../middlewares/idempotency.middleware';

const router = Router();

// Public — no auth needed
router.get('/', listMarkets);
router.get('/on-chain/:onChainMarketId', getMarketByOnChainId);
router.get('/on-chain/:onChainMarketId/state', getOnChainMarketState);

// Admin only: each run calls paid LLM APIs and the treasury.
// Idempotency-Key required (#123): a retry replays the stored 202 and its
// jobId instead of starting a second paid market-maker cycle.
router.post('/generate', generateLimiter, requireAuth, requirePermission('markets.generate'), idempotent({ required: true }), triggerMarketGeneration);
router.get('/generation-status/:jobId', requireAuth, getMarketGenerationStatus);

router.get('/:id', getMarket);

export default router;
