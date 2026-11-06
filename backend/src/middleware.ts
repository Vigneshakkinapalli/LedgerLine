import type { ErrorRequestHandler, RequestHandler } from 'express';
import crypto from 'node:crypto';
import { query } from './db/pool.js';
import { AppError, forbidden } from './errors.js';
import { verifyAccessToken } from './auth/jwt.js';
import type { RoleName } from './auth/types.js';

export const correlationId: RequestHandler = (req, res, next) => {
  const supplied = req.header('x-correlation-id');
  const value = supplied && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied) ? supplied : crypto.randomUUID();
  req.headers['x-correlation-id'] = value;
  res.setHeader('x-correlation-id', value);
  next();
};

export const notFound: RequestHandler = (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required');
    const claims = verifyAccessToken(header.slice(7));
    const result = await query<{ id: string; email: string; roles: string[]; session_id: string }>(
      `SELECT u.id, u.email, s.id AS session_id, COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
       FROM users u
       JOIN auth_sessions s ON s.user_id = u.id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1 AND s.id = $2 AND u.status = 'active' AND s.revoked_at IS NULL AND s.expires_at > now()
       GROUP BY u.id, u.email, s.id`,
      [claims.sub, claims.sid]
    );
    if (result.rows.length !== 1) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required');
    req.auth = { id: result.rows[0].id, email: result.rows[0].email, sessionId: result.rows[0].session_id, roles: result.rows[0].roles as RoleName[] };
    next();
  } catch (error) {
    next(error instanceof AppError ? error : new AppError(401, 'UNAUTHENTICATED', 'Authentication is required'));
  }
};

export const requireRoles = (...required: RoleName[]): RequestHandler => (req, _res, next) => {
  if (!req.auth) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required'));
  if (!required.some(role => req.auth?.roles.includes(role))) return next(forbidden());
  return next();
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : error }));
  if (error instanceof AppError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  if (error?.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'The requested resource already exists' } });
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
};
