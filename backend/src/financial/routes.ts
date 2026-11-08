import { Router } from 'express';
import { authenticate, requireRoles } from '../middleware.js';
import { validationError } from '../errors.js';
import { amountOnlySchema, analyticsQuerySchema, statementQuerySchema, transferSchema } from './schemas.js';
import { approveTransaction, auditVerification, executeOperation, reverseTransaction, statement, transactionDetail } from './service.js';
import { analytics } from './reporting.js';
import { transactionRateLimit } from './rate-limit.js';

function idempotency(req: { header(name: string): string | undefined }): string {
  const value = req.header('idempotency-key');
  if (!value || value.length < 8 || value.length > 255) throw validationError('Idempotency-Key must be between 8 and 255 characters');
  return value;
}

export const financialRouter = Router();
financialRouter.get('/analytics', authenticate, requireRoles('ADMIN', 'AUDITOR'), async (req, res, next) => {
  const parsed = analyticsQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(validationError('Analytics filters are invalid'));
  try { return res.json(await analytics(parsed.data)); } catch (error) { return next(error); }
});
financialRouter.get('/accounts/:accountId/transactions', authenticate, async (req, res, next) => {
  const parsed = statementQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(validationError('page must be positive and pageSize must be between 1 and 100'));
  try { return res.json(await statement(String(req.params.accountId), req.auth!, parsed.data)); } catch (error) { return next(error); }
});
financialRouter.post('/transactions/:transactionId/reverse', authenticate, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const key = req.header('idempotency-key');
    if (!key || key.length < 8 || key.length > 255) return next(validationError('Idempotency-Key must be between 8 and 255 characters'));
    const result = await reverseTransaction(String(req.params.transactionId), req.auth!, key, req.header('x-correlation-id'));
    return res.status(result.status).json(result.body);
  } catch (error) { return next(error); }
});
financialRouter.get('/transactions/:transactionId', authenticate, async (req, res, next) => {
  try { return res.json(await transactionDetail(String(req.params.transactionId), req.auth!)); } catch (error) { return next(error); }
});
financialRouter.post('/transactions/:transactionId/approve', authenticate, requireRoles('ADMIN'), async (req, res, next) => {
  try { const result = await approveTransaction(String(req.params.transactionId), req.auth!, req.header('x-correlation-id')); return res.status(result.status).json(result.body); } catch (error) { return next(error); }
});
financialRouter.post('/accounts/:accountId/deposit', authenticate, transactionRateLimit, async (req, res, next) => {
  const parsed = amountOnlySchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('amountPaise must be a positive integer string'));
  try { const result = await executeOperation({ operation: 'deposit', accountId: String(req.params.accountId), amountPaise: BigInt(parsed.data.amountPaise), idempotencyKey: idempotency(req), actor: req.auth!, correlationId: req.header('x-correlation-id') }); return res.status(result.status).json(result.body); } catch (error) { return next(error); }
});
financialRouter.post('/accounts/:accountId/withdraw', authenticate, transactionRateLimit, async (req, res, next) => {
  const parsed = amountOnlySchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('amountPaise must be a positive integer string'));
  try { const result = await executeOperation({ operation: 'withdrawal', accountId: String(req.params.accountId), amountPaise: BigInt(parsed.data.amountPaise), idempotencyKey: idempotency(req), actor: req.auth!, correlationId: req.header('x-correlation-id') }); return res.status(result.status).json(result.body); } catch (error) { return next(error); }
});
financialRouter.post('/accounts/:accountId/transfer', authenticate, transactionRateLimit, async (req, res, next) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('destinationAccountId and a positive amountPaise are required'));
  try { const result = await executeOperation({ operation: 'transfer', accountId: String(req.params.accountId), destinationAccountId: parsed.data.destinationAccountId, amountPaise: BigInt(parsed.data.amountPaise), idempotencyKey: idempotency(req), actor: req.auth!, correlationId: req.header('x-correlation-id') }); return res.status(result.status).json(result.body); } catch (error) { return next(error); }
});
