import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middlewares/auth.middleware';
import {
  ackDispute,
  addOperationSignature,
  cancelDisputeTx,
  cancelTreasuryOperation,
  createOperation,
  getReconciliationRun,
  getSystemStatus,
  getTraceAuditSummary,
  getTreasury,
  getTreasuryOperation,
  listReconciliationRuns,
  listTreasuryOperations,
  recordTreasuryOperation,
  submitTreasuryOperation,
  triggerReconciliationRun,
  triggerTraceAuditRun,
  voidDisputeTx,
} from '../controllers/admin.controller';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/treasury', getTreasury);
router.get('/treasury/operations', listTreasuryOperations);
router.post('/treasury/operations', createOperation);
router.get('/treasury/operations/:id', getTreasuryOperation);
router.post('/treasury/operations/:id/signatures', addOperationSignature);
router.post('/treasury/operations/:id/submit', submitTreasuryOperation);
router.post('/treasury/operations/:id/record', recordTreasuryOperation);
router.post('/treasury/operations/:id/cancel', cancelTreasuryOperation);
router.get('/status', getSystemStatus);
router.get('/disputes', getDisputes);
router.post('/disputes/:id/ack', ackDispute);
router.post('/disputes/:id/cancel-tx', cancelDisputeTx);
router.post('/disputes/:id/void-tx', voidDisputeTx);
router.get('/trace-audit', getTraceAuditSummary);
router.post('/trace-audit/run', triggerTraceAuditRun);
router.get('/reconciliation/runs', listReconciliationRuns);
router.get('/reconciliation/runs/:id', getReconciliationRun);
router.post('/reconciliation/run', triggerReconciliationRun);

export default router;
