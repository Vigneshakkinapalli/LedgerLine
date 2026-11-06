import { Router } from 'express';
import { authenticate, requireRoles } from '../middleware.js';
import { createAccount, createAccountInput, getAccount, grantPermission, listAccounts, listTransferDestinations, setAccountLimits, updateAccountStatus } from './service.js';
import { permissionSchema } from '../auth/schemas.js';
import { limitSchema, statusSchema } from '../financial/schemas.js';
import { validationError } from '../errors.js';

export const accountRouter = Router();
accountRouter.post('/', authenticate, async (req, res, next) => {
  const parsed = createAccountInput.safeParse(req.body);
  if (!parsed.success) return next(validationError('userId and supported currency are required'));
  try { return res.status(201).json({ account: await createAccount(parsed.data.userId, parsed.data.currency, req.auth!, req.header('x-correlation-id')) }); } catch (error) { return next(error); }
});
accountRouter.get('/', authenticate, async (req, res, next) => {
  try { return res.json({ accounts: await listAccounts(req.auth!) }); } catch (error) { return next(error); }
});
accountRouter.get('/:accountId/transfer-destinations', authenticate, async (req, res, next) => {
  try { return res.json({ accounts: await listTransferDestinations(String(req.params.accountId), req.auth!) }); } catch (error) { return next(error); }
});
accountRouter.get('/:accountId', authenticate, async (req, res, next) => {
  try { return res.json({ account: await getAccount(String(req.params.accountId), req.auth!) }); } catch (error) { return next(error); }
});

accountRouter.post('/:accountId/permissions', authenticate, requireRoles('ADMIN'), async (req, res, next) => {
  const parsed = permissionSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('userId and a valid account permission are required'));
  try {
    await grantPermission(String(req.params.accountId), parsed.data.userId, parsed.data.permission, req.auth!, req.header('x-correlation-id'));
    return res.status(204).send();
  } catch (error) { return next(error); }
});

accountRouter.patch('/:accountId/status', authenticate, requireRoles('ADMIN'), async (req, res, next) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('status must be active, frozen, or closed'));
  try { await updateAccountStatus(String(req.params.accountId), parsed.data.status, req.auth!, req.header('x-correlation-id')); return res.status(204).send(); } catch (error) { return next(error); }
});

accountRouter.put('/:accountId/limits', authenticate, requireRoles('ADMIN'), async (req, res, next) => {
  const parsed = limitSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('daily debit and credit limits must be positive integer strings'));
  try { await setAccountLimits(String(req.params.accountId), parsed.data.dailyDebitLimitPaise, parsed.data.dailyCreditLimitPaise, req.auth!, req.header('x-correlation-id')); return res.status(204).send(); } catch (error) { return next(error); }
});
