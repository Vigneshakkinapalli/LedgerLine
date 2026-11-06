import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { config } from './config.js';
import { query } from './db/pool.js';
import { authenticate, correlationId, errorHandler, notFound } from './middleware.js';
import { authRouter } from './auth/routes.js';
import { accountRouter } from './accounts/routes.js';
import { adminRouter } from './admin/routes.js';
import { financialRouter } from './financial/routes.js';

export const app = express();
app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use(correlationId);
app.get('/health', async (_req, res, next) => {
  try { await query('SELECT 1'); res.json({ status: 'ok', database: 'ok' }); } catch (error) { next(error); }
});
app.get('/api/v1/status', (_req, res) => res.json({ service: 'ledgerline-api', phase: 1 }));
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/accounts', accountRouter);
app.use('/api/v1/admin', adminRouter);
app.get('/api/v1/notifications', authenticate, async (req, res, next) => {
  try { const { query } = await import('./db/pool.js'); const result = await query('SELECT ae.id, ae.event_type, ae.entity_type, ae.entity_id, ae.metadata, ae.created_at, nr.read_at IS NOT NULL AS is_read FROM audit_events ae LEFT JOIN notification_reads nr ON nr.event_id = ae.id AND nr.user_id = $1 WHERE ae.actor_user_id = $1 OR ae.entity_id IN (SELECT id FROM accounts WHERE owner_user_id = $1) ORDER BY ae.created_at DESC LIMIT 100', [req.auth!.id]); return res.json({ notifications: result.rows }); } catch (error) { return next(error); }
});
app.post('/api/v1/notifications/:eventId/read', authenticate, async (req, res, next) => { try { const { query } = await import('./db/pool.js'); await query('INSERT INTO notification_reads (user_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.auth!.id, String(req.params.eventId)]); return res.status(204).send(); } catch (error) { return next(error); } });
app.use('/api/v1', financialRouter);
app.post('/api/v1/validation/amount', (req, res) => {
  const result = z.object({ amountPaise: z.coerce.bigint().positive() }).safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'amountPaise must be a positive integer in paise' } });
  return res.json({ amountPaise: result.data.amountPaise.toString() });
});
app.use(notFound);
app.use(errorHandler);
