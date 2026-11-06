import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

const WINDOW_MS = 60_000;
const MAX_OPERATIONS = 60;
const counters = new Map<string, { count: number; resetAt: number }>();

export const transactionRateLimit: RequestHandler = (req, _res, next) => {
  const userId = req.auth?.id;
  if (!userId) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required'));
  const current = counters.get(userId);
  if (!current || current.resetAt <= Date.now()) {
    counters.set(userId, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return next();
  }
  if (current.count >= MAX_OPERATIONS) return next(new AppError(429, 'TRANSACTION_RATE_LIMITED', 'Too many transaction requests; try again later'));
  current.count += 1;
  return next();
};

export function resetTransactionRateLimitForTests(): void { counters.clear(); }
