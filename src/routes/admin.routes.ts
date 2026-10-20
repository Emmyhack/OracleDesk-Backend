import { Router } from 'express';
import { requireAuth, requirePermission, requireStepUp } from '../middlewares/auth.middleware';
import {
  ackDispute,
  addOperationSignature,
  cancelDisputeTx,
  cancelTreasuryOperation,
  createOperation,
  getAdminAudit,
  getAdminRoles,
  getAdmins,
  getAgentControls,
  getReconciliationRun,
  getSpecCompat,
  getSystemStatus,
  getChainFeesReport,
  pauseAgentControl,
  postGrantAdmin,
  postRevokeAdmin,
  resumeAgentControl,
  getTraceAuditSummary,
  getTreasury,
  getTreasuryOperation,
  getDisputes,
  listReconciliationRuns,
  listTreasuryOperations,
  recordTreasuryOperation,
  submitTreasuryOperation,
  triggerReconciliationRun,
  triggerTraceAuditRun,
  voidDisputeTx,
} from '../controllers/admin.controller';

const router = Router();

router.use(requireAuth);

// Admin management (#49). Reading the admin list and audit trail requires
// step-up; grant/revoke additionally require admin.manage. The service writes
// the audit row in the same transaction as the change, so they opt out of the
// generic request audit.
router.get('/admins', requirePermission('admin.read'), requireStepUp, getAdmins);
router.get('/roles', requirePermission('admin.read'), getAdminRoles);
router.post('/admins/grant', requirePermission('admin.manage', { audit: false }), requireStepUp, postGrantAdmin);
router.post('/admins/revoke', requirePermission('admin.manage', { audit: false }), requireStepUp, postRevokeAdmin);
router.get('/audit', requirePermission('admin.audit.read'), requireStepUp, getAdminAudit);

router.get('/treasury', requirePermission('treasury.read'), getTreasury);
router.get('/treasury/operations', requirePermission('treasury.read'), listTreasuryOperations);
router.post('/treasury/operations', requirePermission('treasury.operate'), requireStepUp, createOperation);
router.get('/treasury/operations/:id', requirePermission('treasury.read'), getTreasuryOperation);
router.post('/treasury/operations/:id/signatures', requirePermission('treasury.operate'), requireStepUp, addOperationSignature);
router.post('/treasury/operations/:id/submit', requirePermission('treasury.operate'), requireStepUp, submitTreasuryOperation);
router.post('/treasury/operations/:id/record', requirePermission('treasury.operate'), requireStepUp, recordTreasuryOperation);
router.post('/treasury/operations/:id/cancel', requirePermission('treasury.operate'), requireStepUp, cancelTreasuryOperation);
router.get('/agents/controls', requirePermission('agents.manage'), getAgentControls);
router.post('/agents/:agent/pause', requirePermission('agents.manage'), pauseAgentControl);
router.post('/agents/:agent/resume', requirePermission('agents.manage'), resumeAgentControl);
router.get('/status', requirePermission('admin.read'), getSystemStatus);
router.get('/fees', requirePermission('admin.read'), getChainFeesReport);
router.get('/disputes', requirePermission('disputes.manage'), getDisputes);
router.post('/disputes/:id/ack', requirePermission('disputes.manage'), ackDispute);
router.post('/disputes/:id/cancel-tx', requirePermission('disputes.manage'), cancelDisputeTx);
router.post('/disputes/:id/void-tx', requirePermission('disputes.manage'), voidDisputeTx);
router.get('/trace-audit', requirePermission('trace_audit.run'), getTraceAuditSummary);
router.post('/trace-audit/run', requirePermission('trace_audit.run'), triggerTraceAuditRun);
router.get('/reconciliation/runs', requirePermission('reconciliation.run'), listReconciliationRuns);
router.get('/reconciliation/runs/:id', requirePermission('reconciliation.run'), getReconciliationRun);
router.post('/reconciliation/run', requirePermission('reconciliation.run'), triggerReconciliationRun);
// Spec compatibility report from the boot gate (#34): read-only diagnostics.
router.get('/chain/spec-compat', requirePermission('admin.read'), getSpecCompat);
router.get('/treasury', getTreasury);
router.get('/treasury/operations', listTreasuryOperations);
router.post('/treasury/operations', createOperation);
router.get('/treasury/operations/:id', getTreasuryOperation);
router.post('/treasury/operations/:id/signatures', addOperationSignature);
router.post('/treasury/operations/:id/submit', submitTreasuryOperation);
router.post('/treasury/operations/:id/record', recordTreasuryOperation);
router.post('/treasury/operations/:id/cancel', cancelTreasuryOperation);
router.get('/agents/controls', getAgentControls);
router.post('/agents/:agent/pause', pauseAgentControl);
router.post('/agents/:agent/resume', resumeAgentControl);
router.get('/status', getSystemStatus);
router.get('/fees', getChainFeesReport);
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
