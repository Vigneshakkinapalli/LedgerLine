import { Router } from 'express';
import { requireAdmin, requireAdminOrAuditor } from '../auth/middleware.js';
import { listUsers, setUserRoles } from '../auth/service.js';
import { roleUpdateSchema } from '../auth/schemas.js';
import { validationError } from '../errors.js';
import { auditVerification, reconciliation, riskAlerts } from '../financial/service.js';
import { reconciliationFindingDetail, reconciliationFindingsForRun, reconciliationHistory, reconciliationSchedule, runReconciliation, updateReconciliationFinding, updateReconciliationSchedule } from '../financial/reporting.js';
import { reconciliationFindingUpdateSchema, reconciliationScheduleSchema, statementQuerySchema } from '../financial/schemas.js';

export const adminRouter = Router();
adminRouter.get('/summary', ...requireAdminOrAuditor, async (_req, res, next) => {
  try {
    const { query } = await import('../db/pool.js');
    const [accounts, transactions] = await Promise.all([
      query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'frozen')::int AS frozen FROM accounts WHERE kind = 'customer'`),
      query(`SELECT transaction_type, status, count(*)::int AS count, COALESCE(sum(amount_paise), 0)::text AS amount_paise FROM ledger_transactions GROUP BY transaction_type, status ORDER BY transaction_type, status`)
    ]);
    return res.json({ accounts: accounts.rows[0], transactions: transactions.rows });
  } catch (error) { return next(error); }
});
adminRouter.get('/reconciliation', ...requireAdminOrAuditor, async (_req, res, next) => {
  try { return res.json(await reconciliation()); } catch (error) { return next(error); }
});
adminRouter.post('/reconciliation/run', ...requireAdmin, async (req, res, next) => {
  try { return res.status(201).json(await runReconciliation(req.auth!, req.header('x-correlation-id'))); } catch (error) { return next(error); }
});
adminRouter.get('/reconciliation/schedule', ...requireAdminOrAuditor, async (_req, res, next) => {
  try { return res.json({ schedule: await reconciliationSchedule() }); } catch (error) { return next(error); }
});
adminRouter.put('/reconciliation/schedule', ...requireAdmin, async (req, res, next) => {
  const parsed = reconciliationScheduleSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('enabled and a daily/weekly cadence are required'));
  try { return res.json({ schedule: await updateReconciliationSchedule(parsed.data, req.auth!, req.header('x-correlation-id')) }); } catch (error) { return next(error); }
});
adminRouter.get('/reconciliation/history', ...requireAdminOrAuditor, async (req, res, next) => {
  const parsed = statementQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(validationError('page must be positive and pageSize must be between 1 and 100'));
  try { return res.json(await reconciliationHistory(parsed.data.page, parsed.data.pageSize)); } catch (error) { return next(error); }
});
adminRouter.get('/reconciliation/findings/:findingId', ...requireAdminOrAuditor, async (req, res, next) => {
  try { return res.json({ finding: await reconciliationFindingDetail(String(req.params.findingId)) }); } catch (error) { return next(error); }
});
adminRouter.get('/reconciliation/runs/:runId/findings', ...requireAdminOrAuditor, async (req, res, next) => {
  try { return res.json({ findings: await reconciliationFindingsForRun(String(req.params.runId)) }); } catch (error) { return next(error); }
});
adminRouter.patch('/reconciliation/findings/:findingId', ...requireAdmin, async (req, res, next) => {
  const parsed = reconciliationFindingUpdateSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('A valid investigating/resolved status and resolution note are required'));
  try { return res.json({ finding: await updateReconciliationFinding(String(req.params.findingId), parsed.data, req.auth!, req.header('x-correlation-id')) }); } catch (error) { return next(error); }
});
adminRouter.get('/risk/alerts', ...requireAdminOrAuditor, async (_req, res, next) => {
  try { return res.json({ alerts: await riskAlerts() }); } catch (error) { return next(error); }
});
adminRouter.get('/audit/verify', ...requireAdminOrAuditor, async (_req, res, next) => {
  try { return res.json(await auditVerification()); } catch (error) { return next(error); }
});
adminRouter.get('/audit/events', ...requireAdminOrAuditor, async (_req, res, next) => {
  try { const result = await import('../db/pool.js').then(({ query }) => query('SELECT id, event_type, entity_type, entity_id, metadata, created_at FROM audit_events ORDER BY created_at DESC LIMIT 500')); return res.json({ events: result.rows }); } catch (error) { return next(error); }
});
adminRouter.get('/users', ...requireAdmin, async (_req, res, next) => {
  try { return res.json({ users: await listUsers() }); } catch (error) { return next(error); }
});

adminRouter.put('/users/:userId/roles', ...requireAdmin, async (req, res, next) => {
  const parsed = roleUpdateSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('roles must contain one or more valid roles'));
  try {
    const user = await setUserRoles(req.auth!, String(req.params.userId), parsed.data.roles, req.header('x-correlation-id'));
    return res.json({ user });
  } catch (error) { return next(error); }
});
