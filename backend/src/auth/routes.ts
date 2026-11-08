import { Router } from 'express';
import { login, logout, recordFailedLogin, register } from './service.js';
import { credentialsSchema, registrationSchema } from './schemas.js';
import { authResponse } from './jwt.js';
import { authenticate } from './middleware.js';
import { isLoginRateLimited, loginRateLimitKey, recordLoginFailure, clearLoginFailures } from './rate-limit.js';
import { AppError, invalidCredentials, validationError } from '../errors.js';

export const authRouter = Router();

function correlation(req: { header(name: string): string | undefined }): string | undefined { return req.header('x-correlation-id'); }

authRouter.post('/register', async (req, res, next) => {
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) return next(validationError('Full name, email and password are required; password must be at least 12 characters'));
  try { return res.status(201).json(await register(parsed.data.email, parsed.data.password, correlation(req), parsed.data.fullName)); } catch (error) { return next(error); }
});

authRouter.post('/login', async (req, res, next) => {
  const parsed = credentialsSchema.safeParse(req.body);
  const email = parsed.success ? parsed.data.email : typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const key = loginRateLimitKey(req.ip ?? 'unknown', email);
  if (isLoginRateLimited(key)) return next(new AppError(429, 'LOGIN_RATE_LIMITED', 'Too many login attempts; try again later'));
  if (!parsed.success) { recordLoginFailure(key); return next(invalidCredentials()); }
  try {
    const result = await login(parsed.data.email, parsed.data.password, correlation(req));
    clearLoginFailures(key);
    return res.json(result);
  } catch (error) {
    recordLoginFailure(key);
    await recordFailedLogin(email, correlation(req)).catch(() => undefined);
    return next(error instanceof AppError && error.code === 'INVALID_CREDENTIALS' ? error : invalidCredentials());
  }
});

authRouter.post('/logout', authenticate, async (req, res, next) => {
  try { await logout(req.auth!, correlation(req)); return res.status(204).send(); } catch (error) { return next(error); }
});

authRouter.get('/me', authenticate, (req, res) => res.json({ user: { id: req.auth!.id, email: req.auth!.email, roles: req.auth!.roles } }));
