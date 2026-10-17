import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { sendError, sendSuccess, parsePagination, buildPaginationMeta } from '../utils/response.util';

const router = Router();

const VERIFICATION_RECIPE = [
  'Find the report trace for the date by walking market_trace_count(REPORT_MARKET_ID) and market_trace_at(REPORT_MARKET_ID, i) on the reasoning registry.',
  'Fetch ipfs_cid, compute sha256 of the exact bytes and compare it with the on-chain trace_hash and the hash below.',
  'Check the report agent equals the treasury RiskConfig.agent.',
  'Recompute snapshot figures from RPC (state may have moved since the anchor; compare lastModifiedLedgerSeq) and period flows from getEvents within retention.',
  'Check the previous on-chain trace id and trace hash form the continuous report chain.',
];

function publicReport(row: any) {
  return {
    date: row.date,
    anchorLedger: row.anchorLedger,
    cid: row.cid,
    ipfsUri: `ipfs://${row.cid}`,
    hash: row.hash,
    onChainTraceId: row.onChainTraceId,
    mode: row.mode,
    consistency: row.consistency,
    createdAt: row.createdAt,
    report: row.report,
    verification: {
      recipe: VERIFICATION_RECIPE,
      command: `npm run verify:report -- --date ${row.date}`,
    },
  };
}

router.get('/', async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query as any);
  const [rows, total] = await Promise.all([
    prisma.transparencyReport.findMany({ orderBy: { date: 'desc' }, skip, take: limit }),
    prisma.transparencyReport.count(),
  ]);
  sendSuccess(res, rows.map(publicReport), 200, buildPaginationMeta(page, limit, total) as any);
});

router.get('/latest', async (_req, res) => {
  const row = await prisma.transparencyReport.findFirst({ orderBy: { date: 'desc' } });
  if (!row) return sendError(res, 404, 'REPORT_NOT_FOUND', 'No transparency report has been published yet');
  sendSuccess(res, publicReport(row));
});

router.get('/:date', async (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'date must be YYYY-MM-DD');
  }
  const row = await prisma.transparencyReport.findUnique({ where: { date } });
  if (!row) return sendError(res, 404, 'REPORT_NOT_FOUND', `No report for ${date}`);
  sendSuccess(res, publicReport(row));
});

export default router;
