import { Router } from 'express';
import authRoutes      from './auth.routes';
import marketRoutes    from './market.routes';
import traceRoutes     from './trace.routes';
import portfolioRoutes from './portfolio.routes';
import tradeRoutes     from './trade.routes';
import oracleRoutes    from './oracle.routes';
import adminRoutes     from './admin.routes';
import reportRoutes    from './reports.routes';
import signerRoutes    from './signer.routes';

const router = Router();

router.use('/auth',      authRoutes);
router.use('/markets',   marketRoutes);
router.use('/traces',    traceRoutes);
router.use('/portfolio', portfolioRoutes);
router.use('/trade',     tradeRoutes);
router.use('/oracle',    oracleRoutes);
router.use('/admin',     adminRoutes);
router.use('/reports',   reportRoutes);
router.use('/signer',    signerRoutes);

export default router;
