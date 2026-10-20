import { Router } from 'express';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';
import { getCalibration, recomputeCalibration } from '../controllers/agents.controller';

const router = Router();

router.get('/calibration', getCalibration);
router.post('/calibration/recompute', requireAuth, requirePermission('calibration.recompute'), recomputeCalibration);

export default router;
