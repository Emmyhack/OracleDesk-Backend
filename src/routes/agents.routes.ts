import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middlewares/auth.middleware';
import { getCalibration, recomputeCalibration } from '../controllers/agents.controller';

const router = Router();

router.get('/calibration', getCalibration);
router.post('/calibration/recompute', requireAuth, requireAdmin, recomputeCalibration);

export default router;
