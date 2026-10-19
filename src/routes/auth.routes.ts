import { Router } from 'express';
import {
  getContractChallenge,
  getPowChallenge,
  postChallenge,
  postContractVerify,
  postRefresh,
  postVerify,
} from '../controllers/auth.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { authLimiter } from '../middlewares/rate-limit.middleware';

const router = Router();

// No Idempotency-Key here (#123): /challenge is harmless to repeat, and
// /verify returns a JWT that must never be stored for replay (its GETDEL
// challenge already makes a duplicate fail with CHALLENGE_NOT_FOUND).
router.post('/challenge', authLimiter, postChallenge);
router.get('/challenge/pow', authLimiter, getPowChallenge);
router.post('/verify', authLimiter, postVerify);
// Refresh keeps the original wallet-proof time; it never performs step-up (#49).
router.post('/refresh', authLimiter, requireAuth, postRefresh);

// SEP-45 (#47). Off unless SEP45_ENABLED=true and WEB_AUTH_CONTRACT_ID is set;
// the service returns 503 SEP45_UNAVAILABLE otherwise.
router.get('/contract/challenge', authLimiter, getContractChallenge);
router.post('/contract/verify', authLimiter, postContractVerify);

export default router;
