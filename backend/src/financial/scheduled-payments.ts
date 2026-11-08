import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { pool, query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { audit } from './audit.js';
import { executeOperation } from './service.js';
import { config } from '../config.js';
import { fingerprint } from './canonical.js';

type Cadence = 'once';
type ScheduleInput = {
  sourceAccountId: string; destinationAccountId: string; amountPaise: string; executeAt: string; description: string; idempotencyKey: string;
  retryLimit: number; retryDelayMinutes: number; reminderMinutes: number;
};

export async function maySchedule(client: PoolClient, accountId: string, actor: AuthenticatedUser): Promise<boolean> {
  const result = await client.query<{ owner_user_id: string | null; status: string; kind: string; currency: string; permission: boolean }>(
    `SELECT a.owner_user_id, a.status, a.kind, a.currency,
            EXISTS (SELECT 1 FROM account_permissions ap WHERE ap.account_id = a.id AND ap.user_id = $2 AND ap.permission = 'transfer') AS permission
     FROM accounts a WHERE a.id = $1 FOR SHARE`, [accountId, actor.id]
  );
  const account = result.rows[0];
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (account.kind !== 'customer' || account.currency !== 'INR' || account.status !== 'active') throw new AppError(422, 'ACCOUNT_UNAVAILABLE', 'Schedule requires an active INR customer account');
  return account.owner_user_id === actor.id || actor.roles.includes('ADMIN') || account.permission;
}

export async function createScheduledPayment(input: ScheduleInput, actor: AuthenticatedUser, correlationId?: string) {
  if (actor.roles.includes('AUDITOR') && !actor.roles.includes('ADMIN')) throw new AppError(403, 'FORBIDDEN', 'Auditors cannot create scheduled payments');
  if (BigInt(input.amountPaise) > config.HIGH_VALUE_THRESHOLD_PAISE) throw new AppError(422, 'HIGH_VALUE_SCHEDULE_UNSUPPORTED', 'Scheduled transfers above the approval threshold must be submitted as an immediate transfer for Admin approval');
  const executeAt = new Date(input.executeAt);
  if (executeAt <= new Date()) throw new AppError(400, 'SCHEDULE_MUST_BE_FUTURE', 'Scheduled execution must be in the future');
  const requestHash = fingerprint(input);
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`scheduled-payment:${actor.id}:${input.idempotencyKey}`]);
    const previous = await client.query<{ id: string; creation_request_hash: string | null; next_run_at: Date; status: string }>(
      'SELECT id,creation_request_hash,next_run_at,status FROM scheduled_payments WHERE owner_user_id=$1 AND creation_request_key=$2 FOR UPDATE',
      [actor.id, input.idempotencyKey]
    );
    if (previous.rows[0]) {
      if (previous.rows[0].creation_request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different schedule request');
      return previous.rows[0];
    }
    if (!await maySchedule(client, input.sourceAccountId, actor)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have transfer permission for this account');
    }
    if (input.sourceAccountId === input.destinationAccountId) throw new AppError(400, 'SAME_ACCOUNT', 'Source and destination accounts must differ');
    const destination = await client.query<{ id: string; kind: string; status: string; currency: string }>('SELECT id, kind, status, currency FROM accounts WHERE id = $1 FOR SHARE', [input.destinationAccountId]);
    if (!destination.rows[0]) throw new AppError(404, 'DESTINATION_NOT_FOUND', 'Destination account not found');
    if (destination.rows[0].kind !== 'customer' || destination.rows[0].status !== 'active' || destination.rows[0].currency !== 'INR') throw new AppError(422, 'DESTINATION_UNAVAILABLE', 'Destination must be an active INR customer account');
    const schedule = await client.query<{ id: string; next_run_at: Date; status: string }>(
      `INSERT INTO scheduled_payments (owner_user_id, source_account_id, destination_account_id, amount_paise, cadence, next_run_at, retry_limit, retry_delay_minutes, reminder_minutes, description, creation_request_key, creation_request_hash)
       VALUES ($1,$2,$3,$4,'once',$5,$6,$7,$8,$9,$10,$11) RETURNING id, next_run_at, status, cadence, description`,
      [actor.id, input.sourceAccountId, input.destinationAccountId, input.amountPaise, executeAt, input.retryLimit, input.retryDelayMinutes, input.reminderMinutes, input.description, input.idempotencyKey, requestHash]
    );
    await audit(client, actor.id, 'SCHEDULED_PAYMENT_CREATED', 'scheduled_payment', schedule.rows[0].id, { amountPaise: input.amountPaise, cadence: 'once', nextRunAt: executeAt.toISOString(), description: input.description }, correlationId);
    return schedule.rows[0];
  });
}

export async function listScheduledPayments(actor: AuthenticatedUser, page = 1, pageSize = 25) {
  const result = await query<{ id: string; source_account_id: string; destination_account_id: string; amount_paise: string; cadence: Cadence; status: string; next_run_at: Date; retry_limit: number; retry_delay_minutes: number; reminder_minutes: number; description: string; created_at: Date; total: string }>(
    `SELECT sp.id,sp.source_account_id,sp.destination_account_id,sp.amount_paise::text,sp.cadence,sp.status,sp.next_run_at,sp.retry_limit,sp.retry_delay_minutes,sp.reminder_minutes,sp.description,sp.created_at,count(*) OVER()::text AS total FROM scheduled_payments sp
    WHERE sp.cadence='once' AND ($1::boolean OR sp.owner_user_id = $2)
     ORDER BY sp.created_at DESC LIMIT $3 OFFSET $4`,
    [actor.roles.includes('ADMIN') || actor.roles.includes('AUDITOR'), actor.id, pageSize, (page - 1) * pageSize]
  );
  return { schedules: result.rows.map(({ total, ...schedule }) => schedule), pagination: { page, pageSize, totalRecords: Number(result.rows[0]?.total ?? 0), totalPages: Math.ceil(Number(result.rows[0]?.total ?? 0) / pageSize) } };
}

export async function listEligibleScheduleSources(actor: AuthenticatedUser) {
  if (actor.roles.includes('AUDITOR') && !actor.roles.includes('ADMIN')) return [];
  const result = await query<{ id: string; code: string; email: string | null; is_owner: boolean; status: string; currency: string }>(
    `SELECT a.id, a.code, u.email, (a.owner_user_id = $1) AS is_owner, a.status, a.currency
     FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id
     WHERE a.kind = 'customer' AND a.status = 'active' AND a.currency = 'INR'
       AND ($2::boolean OR a.owner_user_id = $1 OR EXISTS (
         SELECT 1 FROM account_permissions ap WHERE ap.account_id = a.id AND ap.user_id = $1 AND ap.permission = 'transfer'
       ))
     ORDER BY a.created_at DESC, a.id`,
    [actor.id, actor.roles.includes('ADMIN')]
  );
  return result.rows.map(account => ({
    id: account.id,
    displayName: account.is_owner && account.email ? `${account.email.split('@')[0]} account` : 'LedgerLine account',
    maskedIdentifier: `•••• ${account.code.replace(/^ACC_/, '').slice(-8).toUpperCase()}`,
    status: account.status,
    currency: account.currency
  }));
}

async function getOwnedSchedule(client: PoolClient, id: string, actor: AuthenticatedUser, lock = false) {
  const result = await client.query<{ id: string; owner_user_id: string; status: string; cadence: Cadence; next_run_at: Date }>(
    `SELECT id, owner_user_id, status, cadence, next_run_at FROM scheduled_payments WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id]
  );
  const schedule = result.rows[0];
  if (!schedule) throw new AppError(404, 'SCHEDULE_NOT_FOUND', 'Scheduled payment not found');
  if (schedule.owner_user_id !== actor.id && !actor.roles.includes('ADMIN') && !actor.roles.includes('AUDITOR')) throw new AppError(404, 'SCHEDULE_NOT_FOUND', 'Scheduled payment not found');
  return schedule;
}

export async function getScheduledPayment(id: string, actor: AuthenticatedUser) {
  const client = await pool.connect();
  try {
    const schedule = await client.query<{ owner_user_id: string }>('SELECT owner_user_id FROM scheduled_payments WHERE id=$1', [id]);
    if (!schedule.rows[0] || schedule.rows[0].owner_user_id !== actor.id && !actor.roles.includes('ADMIN') && !actor.roles.includes('AUDITOR')) throw new AppError(404, 'SCHEDULE_NOT_FOUND', 'Scheduled payment not found');
    const [details, executions] = await Promise.all([
      client.query('SELECT * FROM scheduled_payments WHERE id=$1', [id]),
      client.query(`SELECT o.id, o.scheduled_for, o.status, o.attempt_count, o.transaction_id, o.last_error_code, o.completed_at,
                    COALESCE(json_agg(json_build_object('attemptNumber', a.attempt_number, 'status', a.status, 'errorCode', a.error_code, 'transactionId', a.transaction_id, 'createdAt', a.created_at) ORDER BY a.attempt_number) FILTER (WHERE a.id IS NOT NULL), '[]') AS attempts
                    FROM scheduled_payment_occurrences o LEFT JOIN scheduled_payment_attempts a ON a.occurrence_id = o.id
                    WHERE o.schedule_id = $1 GROUP BY o.id ORDER BY o.scheduled_for DESC LIMIT 100`, [id])
    ]);
    return { schedule: details.rows[0], executions: executions.rows };
  } finally { client.release(); }
}

export async function actOnScheduledPayment(id: string, action: 'pause' | 'resume' | 'cancel', actor: AuthenticatedUser, correlationId?: string) {
  return withTransaction(async client => {
    const schedule = await getOwnedSchedule(client, id, actor, true);
    if (actor.roles.includes('AUDITOR') && !actor.roles.includes('ADMIN')) throw new AppError(403, 'FORBIDDEN', 'Auditors cannot modify scheduled payments');
    if (action === 'pause' && schedule.status !== 'active') throw new AppError(409, 'SCHEDULE_NOT_ACTIVE', 'Only active schedules can be paused');
    if (action === 'resume' && schedule.status !== 'paused') throw new AppError(409, 'SCHEDULE_NOT_PAUSED', 'Only paused schedules can be resumed');
    if (action === 'cancel' && !['active', 'paused'].includes(schedule.status)) throw new AppError(409, 'SCHEDULE_NOT_CANCELLABLE', 'Schedule can no longer be cancelled');
    const nextStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
    const updated = await client.query('UPDATE scheduled_payments SET status = $2, reminder_sent_for = NULL, updated_at = now() WHERE id = $1 RETURNING *', [id, nextStatus]);
    if (action === 'cancel') await client.query("UPDATE scheduled_payment_occurrences SET status = 'cancelled', processing_until = NULL WHERE schedule_id = $1 AND status IN ('pending','processing')", [id]);
    const eventType = action === 'cancel' ? 'SCHEDULED_PAYMENT_CANCELLED' : `SCHEDULED_PAYMENT_${action.toUpperCase()}D`;
    await audit(client, actor.id, eventType, 'scheduled_payment', id, { action }, correlationId);
    return updated.rows[0];
  });
}

async function actorFor(userId: string): Promise<AuthenticatedUser | null> {
  const result = await query<{ id: string; email: string; roles: string[] }>(
    `SELECT u.id, u.email, COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id
     WHERE u.id=$1 AND u.status='active' GROUP BY u.id`, [userId]
  );
  const row = result.rows[0];
  return row ? { id: row.id, email: row.email, roles: row.roles as AuthenticatedUser['roles'], sessionId: 'scheduled-payment-worker' } : null;
}

async function emitReminders() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query<{ id: string; owner_user_id: string; next_run_at: Date; reminder_minutes: number }>(
      `SELECT id, owner_user_id, next_run_at, reminder_minutes FROM scheduled_payments
       WHERE status='active' AND reminder_minutes > 0 AND next_run_at <= now() + reminder_minutes * interval '1 minute'
         AND next_run_at > now() AND (reminder_sent_for IS NULL OR reminder_sent_for <> next_run_at)
       ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED`
    );
    for (const schedule of due.rows) {
      await client.query('UPDATE scheduled_payments SET reminder_sent_for = next_run_at WHERE id = $1', [schedule.id]);
      await audit(client, schedule.owner_user_id, 'SCHEDULED_PAYMENT_REMINDER', 'scheduled_payment', schedule.id, { scheduledFor: schedule.next_run_at.toISOString() }, undefined);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function ensureDueOccurrences() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query<{ id: string; owner_user_id: string; cadence: Cadence; next_run_at: Date }>(
      `SELECT id, owner_user_id, cadence, next_run_at FROM scheduled_payments
      WHERE status='active' AND cadence='once' AND next_run_at <= now()
         AND NOT EXISTS (SELECT 1 FROM scheduled_payment_occurrences o WHERE o.schedule_id=scheduled_payments.id AND o.scheduled_for=scheduled_payments.next_run_at)
       ORDER BY next_run_at, id LIMIT 50 FOR UPDATE SKIP LOCKED`
    );
    for (const schedule of due.rows) {
      await client.query('INSERT INTO scheduled_payment_occurrences (schedule_id, scheduled_for) VALUES ($1,$2) ON CONFLICT (schedule_id, scheduled_for) DO NOTHING', [schedule.id, schedule.next_run_at]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function claimOccurrence() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const occurrence = await client.query<{ id: string; schedule_id: string; owner_user_id: string; source_account_id: string; destination_account_id: string; amount_paise: string; retry_limit: number; retry_delay_minutes: number; attempt_count: number; status: string }>(
      `SELECT o.id, o.schedule_id, s.owner_user_id, s.source_account_id, s.destination_account_id, s.amount_paise::text, s.retry_limit, s.retry_delay_minutes, o.attempt_count, o.status
       FROM scheduled_payment_occurrences o JOIN scheduled_payments s ON s.id=o.schedule_id
       WHERE o.status IN ('pending','processing') AND (o.next_retry_at IS NULL OR o.next_retry_at <= now())
         AND (o.processing_until IS NULL OR o.processing_until < now()) AND s.status='active' AND s.cadence='once'
       ORDER BY o.scheduled_for, o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`
    );
    const row = occurrence.rows[0];
    if (!row) { await client.query('COMMIT'); return null; }
    const attemptNumber = row.status === 'processing' ? row.attempt_count : row.attempt_count + 1;
    const idempotencyKey = `scheduled-${row.schedule_id}-${row.id}-${attemptNumber}`;
    await client.query(
      `INSERT INTO scheduled_payment_attempts (occurrence_id, attempt_number, idempotency_key)
       VALUES ($1,$2,$3) ON CONFLICT (occurrence_id, attempt_number) DO NOTHING`, [row.id, attemptNumber, idempotencyKey]
    );
    await client.query("UPDATE scheduled_payment_occurrences SET status='processing', attempt_count=$2, processing_until=now()+interval '2 minutes' WHERE id=$1", [row.id, attemptNumber]);
    await client.query('COMMIT');
    return { ...row, attemptNumber, idempotencyKey };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function finishOccurrence(claim: NonNullable<Awaited<ReturnType<typeof claimOccurrence>>>, result: { status: number; body: Record<string, unknown> } | null, errorCode?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const occurrence = await client.query<{ retry_limit: number; retry_delay_minutes: number; owner_user_id: string }>(
      'SELECT s.retry_limit,s.retry_delay_minutes,s.owner_user_id FROM scheduled_payment_occurrences o JOIN scheduled_payments s ON s.id=o.schedule_id WHERE o.id=$1 FOR UPDATE OF o', [claim.id]
    );
    const policy = occurrence.rows[0];
    const transaction = (result?.body.transaction ?? {}) as { id?: string };
    const refused = result?.body.error as { code?: string } | undefined;
    const failure = errorCode ?? refused?.code ?? (result?.status === 202 ? 'APPROVAL_REQUIRED' : undefined);
    if (result?.status === 201 && transaction.id) {
      await client.query("UPDATE scheduled_payment_attempts SET status='succeeded', transaction_id=$2,response_status=$3,completed_at=now() WHERE occurrence_id=$1 AND attempt_number=$4", [claim.id, transaction.id, result.status, claim.attemptNumber]);
      await client.query("UPDATE scheduled_payment_occurrences SET status='succeeded',transaction_id=$2,processing_until=NULL,completed_at=now(),last_error_code=NULL WHERE id=$1", [claim.id, transaction.id]);
      await client.query("UPDATE scheduled_payments SET status='completed',updated_at=now() WHERE id=$1", [claim.schedule_id]);
      await audit(client, policy.owner_user_id, 'SCHEDULED_PAYMENT_EXECUTED', 'scheduled_payment', claim.schedule_id, { occurrenceId: claim.id, transactionId: transaction.id, attempt: claim.attemptNumber }, undefined);
    } else {
      const retryable = failure === 'INSUFFICIENT_FUNDS' || result === null || (result?.status ?? 500) >= 500;
      const canRetry = retryable && claim.attemptNumber <= policy.retry_limit;
      await client.query('UPDATE scheduled_payment_attempts SET status=$3, response_status=$4,error_code=$5,completed_at=now() WHERE occurrence_id=$1 AND attempt_number=$2', [claim.id, claim.attemptNumber, canRetry ? 'retryable_failure' : 'terminal_failure', result?.status ?? 500, failure ?? 'EXECUTION_FAILED']);
      await client.query(
        `UPDATE scheduled_payment_occurrences SET status=$2, processing_until=NULL,
             next_retry_at=CASE WHEN $2='pending' THEN now()+($3 * interval '1 minute') ELSE NULL END,
             last_error_code=$4, completed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END
         WHERE id=$1`,
        [claim.id, canRetry ? 'pending' : 'failed', policy.retry_delay_minutes, failure ?? 'EXECUTION_FAILED']
      );
      await audit(client, policy.owner_user_id, canRetry ? 'SCHEDULED_PAYMENT_RETRY_QUEUED' : 'SCHEDULED_PAYMENT_FAILED', 'scheduled_payment', claim.schedule_id, { occurrenceId: claim.id, errorCode: failure ?? 'EXECUTION_FAILED', attempt: claim.attemptNumber }, undefined);
      if (!canRetry) await client.query("UPDATE scheduled_payments SET status='completed',updated_at=now() WHERE id=$1", [claim.schedule_id]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function pollScheduledPayments(maxExecutions = 10): Promise<number> {
  await emitReminders();
  await ensureDueOccurrences();
  let completed = 0;
  for (let index = 0; index < maxExecutions; index += 1) {
    const claim = await claimOccurrence();
    if (!claim) break;
    let execution: { status: number; body: Record<string, unknown> } | null = null;
    let failure: string | undefined;
    try {
      const actor = await actorFor(claim.owner_user_id);
      if (!actor) failure = 'SCHEDULE_OWNER_UNAVAILABLE';
      else if (actor.roles.includes('AUDITOR') && !actor.roles.includes('ADMIN')) failure = 'SCHEDULE_OWNER_NOT_ALLOWED';
      else execution = await executeOperation({ operation: 'transfer', accountId: claim.source_account_id, destinationAccountId: claim.destination_account_id, amountPaise: BigInt(claim.amount_paise), idempotencyKey: claim.idempotencyKey, actor });
    } catch (error) { failure = error instanceof AppError ? error.code : 'EXECUTION_ERROR'; }
    await finishOccurrence(claim, execution, failure);
    completed += 1;
  }
  return completed;
}
