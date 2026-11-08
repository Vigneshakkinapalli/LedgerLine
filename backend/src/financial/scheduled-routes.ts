import { Router } from 'express';
import { authenticate } from '../middleware.js';
import { validationError } from '../errors.js';
import { statementQuerySchema, scheduledPaymentActionSchema, scheduledPaymentCreateSchema, recurringPaymentCreateSchema } from './schemas.js';
import { actOnScheduledPayment, createScheduledPayment, getScheduledPayment, listEligibleScheduleSources, listScheduledPayments } from './scheduled-payments.js';
import { actOnRecurringPayment, createRecurringPayment, getRecurringPayment, listRecurringPayments } from './recurring-payments.js';

export const scheduledPaymentRouter = Router();

function creationKey(req: { header(name: string): string | undefined }) {
  const key = req.header('idempotency-key');
  if (!key || key.length < 8 || key.length > 255) throw validationError('Idempotency-Key must be between 8 and 255 characters');
  return key;
}

scheduledPaymentRouter.get('/eligible-accounts', authenticate, async (req, res, next) => {
  try { return res.json({ accounts: await listEligibleScheduleSources(req.auth!) }); } catch (error) { return next(error); }
});

scheduledPaymentRouter.get('/', authenticate, async (req, res, next) => {
  const parsed = statementQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(validationError('page must be positive and pageSize must be between 1 and 100'));
  try { return res.json(await listScheduledPayments(req.auth!, parsed.data.page, parsed.data.pageSize)); } catch (error) { return next(error); }
});

scheduledPaymentRouter.post('/', authenticate, async (req, res, next) => {
  const parsed = scheduledPaymentCreateSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('Scheduled payment fields are invalid'));
  try { return res.status(201).json({ schedule: await createScheduledPayment({ ...parsed.data, idempotencyKey: creationKey(req) }, req.auth!, req.header('x-correlation-id')) }); }
  catch (error) { return next(error); }
});

export const recurringPaymentRouter = Router();
recurringPaymentRouter.get('/', authenticate, async (req, res, next) => {
  const parsed = statementQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(validationError('page must be positive and pageSize must be between 1 and 100'));
  try { return res.json(await listRecurringPayments(req.auth!, parsed.data.page, parsed.data.pageSize)); } catch (error) { return next(error); }
});

recurringPaymentRouter.post('/', authenticate, async (req, res, next) => {
  const parsed = recurringPaymentCreateSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('Recurring payment fields are invalid'));
  try { return res.status(201).json({ payment: await createRecurringPayment({ ...parsed.data, idempotencyKey: creationKey(req) }, req.auth!, req.header('x-correlation-id')) }); }
  catch (error) { return next(error); }
});

recurringPaymentRouter.get('/:paymentId', authenticate, async (req, res, next) => {
  try { return res.json(await getRecurringPayment(String(req.params.paymentId), req.auth!)); } catch (error) { return next(error); }
});

recurringPaymentRouter.post('/:paymentId/actions', authenticate, async (req, res, next) => {
  const parsed = scheduledPaymentActionSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('action must be pause, resume, or cancel'));
  try { return res.json({ payment: await actOnRecurringPayment(String(req.params.paymentId), parsed.data.action, req.auth!, req.header('x-correlation-id')) }); }
  catch (error) { return next(error); }
});

scheduledPaymentRouter.get('/:scheduleId', authenticate, async (req, res, next) => {
  try { return res.json(await getScheduledPayment(String(req.params.scheduleId), req.auth!)); } catch (error) { return next(error); }
});

scheduledPaymentRouter.post('/:scheduleId/actions', authenticate, async (req, res, next) => {
  const parsed = scheduledPaymentActionSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('action must be pause, resume, or cancel'));
  try { return res.json({ schedule: await actOnScheduledPayment(String(req.params.scheduleId), parsed.data.action, req.auth!, req.header('x-correlation-id')) }); }
  catch (error) { return next(error); }
});
