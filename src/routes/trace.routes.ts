import { Router } from 'express';
import {
  createIntent,
  getIntent,
  getMyPaymentEvents,
  getMySpendingAllowance,
  getTrace,
  listTraces,
  preauthorizeAccess,
  setSpendingAllowance,
  submitIntent,
  unlockTrace,
  verifyTrace,
} from '../controllers/trace.controller';
import { optionalAuth, requireAuth } from '../middlewares/auth.middleware';
import { idempotent } from '../middlewares/idempotency.middleware';

const router = Router();

// Public
router.get('/',             listTraces);
router.get('/access/allowance', requireAuth, getMySpendingAllowance);
router.put('/access/allowance', requireAuth, idempotent(), setSpendingAllowance);
router.post('/access/preauthorize', requireAuth, preauthorizeAccess);
router.get('/payments', requireAuth, getMyPaymentEvents);
router.post('/payment-intents', requireAuth, createIntent);
router.get('/payment-intents/:id', requireAuth, getIntent);
router.post('/payment-intents/:id/submit', requireAuth, submitIntent);
router.get('/:id', optionalAuth, getTrace);   // Preview without a token, full trace with a daily pass

// Protected
// Idempotency-Key optional (#123). Lock is 60s by default, above verify's 20s IPFS timeout.
router.post('/verify',       requireAuth, idempotent(), verifyTrace);
router.post('/:id/unlock',   requireAuth, idempotent(), unlockTrace);

export default router;
