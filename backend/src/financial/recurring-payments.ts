import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthenticatedUser } from '../auth/types.js';
import { AppError } from '../errors.js';
import { pool, query } from '../db/pool.js';
import { config } from '../config.js';
import { withTransaction } from '../db/transaction.js';
import { audit } from './audit.js';
import { executeOperation } from './service.js';
import { maySchedule } from './scheduled-payments.js';
import { fingerprint } from './canonical.js';

export type RecurringFrequency = 'daily' | 'weekly' | 'monthly';

export function advanceScheduleDate(from: Date, frequency: RecurringFrequency): Date {
  const next = new Date(from);
  if (frequency === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (frequency === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else {
    const month = from.getUTCMonth() + 1;
    const daysInTargetMonth = new Date(Date.UTC(from.getUTCFullYear(), month + 1, 0)).getUTCDate();
    next.setUTCFullYear(from.getUTCFullYear(), month, Math.min(from.getUTCDate(), daysInTargetMonth));
  }
  return next;
}
type CreateRecurring = {
  sourceAccountId: string; destinationAccountId: string; amountPaise: string; frequency: RecurringFrequency;
  startAt: string; endsAt?: string; description: string; idempotencyKey: string;
  retryLimit: number; retryDelayMinutes: number; reminderMinutes: number;
};

export async function createRecurringPayment(input: CreateRecurring, actor: AuthenticatedUser, correlationId?: string) {
  if (actor.roles.includes('AUDITOR') && !actor.roles.includes('ADMIN')) throw new AppError(403, 'FORBIDDEN', 'Auditors cannot create recurring payments');
  if (BigInt(input.amountPaise) > config.HIGH_VALUE_THRESHOLD_PAISE) throw new AppError(422, 'HIGH_VALUE_SCHEDULE_UNSUPPORTED', 'Recurring transfers above the approval threshold must be submitted as immediate transfers for Admin approval');
  const startAt = new Date(input.startAt);
  if (startAt <= new Date()) throw new AppError(400, 'SCHEDULE_MUST_BE_FUTURE', 'Recurring payment start must be in the future');
  if (input.endsAt && new Date(input.endsAt) < startAt) throw new AppError(400, 'INVALID_END_DATE', 'End date must be on or after start date');
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recurring-payment:${actor.id}:${input.idempotencyKey}`]);
    const requestHash = fingerprint(input);
    const existing = await client.query<{ id: string; creation_request_hash: string | null; next_execution_at: Date; status: string; frequency: string; description: string }>(
      'SELECT id,creation_request_hash,next_execution_at,status,frequency,description FROM recurring_payments WHERE owner_user_id=$1 AND creation_request_key=$2 FOR UPDATE',
      [actor.id, input.idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].creation_request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different recurring-payment request');
      return existing.rows[0];
    }
    if (!await maySchedule(client, input.sourceAccountId, actor)) throw new AppError(403, 'FORBIDDEN', 'You do not have transfer permission for this account');
    if (input.sourceAccountId === input.destinationAccountId) throw new AppError(400, 'SAME_ACCOUNT', 'Source and destination accounts must differ');
    const destination = await client.query<{ id: string; kind: string; status: string; currency: string }>('SELECT id,kind,status,currency FROM accounts WHERE id=$1 FOR SHARE', [input.destinationAccountId]);
    if (!destination.rows[0]) throw new AppError(404, 'DESTINATION_NOT_FOUND', 'Destination account not found');
    if (destination.rows[0].kind !== 'customer' || destination.rows[0].status !== 'active' || destination.rows[0].currency !== 'INR') throw new AppError(422, 'DESTINATION_UNAVAILABLE', 'Destination must be an active INR customer account');
    const created = await client.query(
      `INSERT INTO recurring_payments (owner_user_id,source_account_id,destination_account_id,amount_paise,frequency,next_execution_at,ends_at,description,retry_limit,retry_delay_minutes,reminder_minutes,creation_request_key,creation_request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id,source_account_id,destination_account_id,amount_paise,frequency,status,next_execution_at,ends_at,description,retry_limit,retry_delay_minutes,reminder_minutes`,
      [actor.id,input.sourceAccountId,input.destinationAccountId,input.amountPaise,input.frequency,startAt,input.endsAt ? new Date(input.endsAt) : null,input.description,input.retryLimit,input.retryDelayMinutes,input.reminderMinutes,input.idempotencyKey,requestHash]
    );
    await audit(client, actor.id, 'RECURRING_PAYMENT_CREATED', 'recurring_payment', created.rows[0].id, { amountPaise: input.amountPaise, frequency: input.frequency, startAt: startAt.toISOString(), endsAt: input.endsAt ?? null, description: input.description }, correlationId);
    return created.rows[0];
  });
}

export async function listRecurringPayments(actor: AuthenticatedUser, page = 1, pageSize = 25) {
  const result = await query(
    `SELECT rp.*,count(*) OVER()::text AS total FROM recurring_payments rp
     WHERE ($1::boolean OR rp.owner_user_id=$2) ORDER BY rp.created_at DESC LIMIT $3 OFFSET $4`,
    [actor.roles.includes('ADMIN') || actor.roles.includes('AUDITOR'),actor.id,pageSize,(page-1)*pageSize]
  );
  return { payments: result.rows.map(({ total, ...payment }) => payment), pagination: { page,pageSize,totalRecords:Number(result.rows[0]?.total ?? 0),totalPages:Math.ceil(Number(result.rows[0]?.total ?? 0)/pageSize) } };
}

async function getVisible(client: PoolClient, id: string, actor: AuthenticatedUser, lock = false) {
  const result = await client.query<{ id:string; owner_user_id:string; status:string }>(`SELECT id,owner_user_id,status FROM recurring_payments WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,[id]);
  if (!result.rows[0] || result.rows[0].owner_user_id !== actor.id && !actor.roles.includes('ADMIN') && !actor.roles.includes('AUDITOR')) throw new AppError(404,'RECURRING_PAYMENT_NOT_FOUND','Recurring payment not found');
  return result.rows[0];
}

export async function getRecurringPayment(id: string, actor: AuthenticatedUser) {
  const client = await pool.connect();
  try {
    await getVisible(client,id,actor);
    const [payment, executions] = await Promise.all([
      client.query('SELECT * FROM recurring_payments WHERE id=$1',[id]),
      client.query(`SELECT o.id,o.scheduled_for,o.status,o.attempt_count,o.transaction_id,o.last_error_code,o.completed_at,
        COALESCE(json_agg(json_build_object('attemptNumber',a.attempt_number,'status',a.status,'errorCode',a.error_code,'transactionId',a.transaction_id,'createdAt',a.created_at) ORDER BY a.attempt_number) FILTER (WHERE a.id IS NOT NULL),'[]') AS attempts
        FROM recurring_payment_occurrences o LEFT JOIN recurring_payment_attempts a ON a.occurrence_id=o.id
        WHERE o.recurring_payment_id=$1 GROUP BY o.id ORDER BY o.scheduled_for DESC LIMIT 100`,[id])
    ]);
    return { payment: payment.rows[0], executions: executions.rows };
  } finally { client.release(); }
}

export async function actOnRecurringPayment(id: string, action: 'pause'|'resume'|'cancel', actor: AuthenticatedUser, correlationId?: string) {
  return withTransaction(async client => {
    const payment = await getVisible(client,id,actor,true);
    if (actor.roles.includes('AUDITOR') && !actor.roles.includes('ADMIN')) throw new AppError(403,'FORBIDDEN','Auditors cannot modify recurring payments');
    if (action === 'pause' && payment.status !== 'active') throw new AppError(409,'RECURRING_PAYMENT_NOT_ACTIVE','Only active recurring payments can be paused');
    if (action === 'resume' && payment.status !== 'paused') throw new AppError(409,'RECURRING_PAYMENT_NOT_PAUSED','Only paused recurring payments can be resumed');
    if (action === 'cancel' && !['active','paused'].includes(payment.status)) throw new AppError(409,'RECURRING_PAYMENT_NOT_CANCELLABLE','Recurring payment can no longer be cancelled');
    const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
    const result = await client.query('UPDATE recurring_payments SET status=$2,reminder_sent_for=NULL,updated_at=now() WHERE id=$1 RETURNING *',[id,status]);
    if (action === 'cancel') await client.query("UPDATE recurring_payment_occurrences SET status='cancelled',processing_until=NULL WHERE recurring_payment_id=$1 AND status IN ('pending','processing')",[id]);
    await audit(client,actor.id,`RECURRING_PAYMENT_${action === 'cancel' ? 'CANCELLED' : `${action.toUpperCase()}D`}`,'recurring_payment',id,{action},correlationId);
    return result.rows[0];
  });
}

async function dueReminders() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query<{id:string;owner_user_id:string;next_execution_at:Date}>(
      `SELECT id,owner_user_id,next_execution_at FROM recurring_payments
       WHERE status='active' AND reminder_minutes>0 AND next_execution_at<=now()+reminder_minutes*interval '1 minute'
        AND next_execution_at>now() AND (reminder_sent_for IS NULL OR reminder_sent_for<>next_execution_at)
       ORDER BY next_execution_at LIMIT 50 FOR UPDATE SKIP LOCKED`);
    for (const payment of due.rows) {
      await client.query('UPDATE recurring_payments SET reminder_sent_for=next_execution_at WHERE id=$1',[payment.id]);
      await audit(client,payment.owner_user_id,'RECURRING_PAYMENT_REMINDER','recurring_payment',payment.id,{scheduledFor:payment.next_execution_at.toISOString()},undefined);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function makeDueOccurrences() {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const due=await client.query<{id:string;frequency:RecurringFrequency;next_execution_at:Date;ends_at:Date|null}>(
      `SELECT id,frequency,next_execution_at,ends_at FROM recurring_payments rp
       WHERE status='active' AND next_execution_at<=now()
        AND NOT EXISTS (SELECT 1 FROM recurring_payment_occurrences o WHERE o.recurring_payment_id=rp.id AND o.scheduled_for=rp.next_execution_at)
       ORDER BY next_execution_at,id LIMIT 50 FOR UPDATE SKIP LOCKED`);
    for (const payment of due.rows) {
      await client.query('INSERT INTO recurring_payment_occurrences (recurring_payment_id,scheduled_for) VALUES ($1,$2) ON CONFLICT DO NOTHING',[payment.id,payment.next_execution_at]);
      const next=advanceScheduleDate(payment.next_execution_at,payment.frequency);
      if (!payment.ends_at || next<=payment.ends_at) await client.query('UPDATE recurring_payments SET next_execution_at=$2,reminder_sent_for=NULL,updated_at=now() WHERE id=$1',[payment.id,next]);
      else await client.query("UPDATE recurring_payments SET status='completed',updated_at=now() WHERE id=$1",[payment.id]);
    }
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function claimRecurring() {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const selected=await client.query<{id:string;recurring_payment_id:string;owner_user_id:string;source_account_id:string;destination_account_id:string;amount_paise:string;retry_limit:number;retry_delay_minutes:number;attempt_count:number;status:string}>(
      `SELECT o.id,o.recurring_payment_id,rp.owner_user_id,rp.source_account_id,rp.destination_account_id,rp.amount_paise::text,rp.retry_limit,rp.retry_delay_minutes,o.attempt_count,o.status
       FROM recurring_payment_occurrences o JOIN recurring_payments rp ON rp.id=o.recurring_payment_id
       WHERE o.status IN ('pending','processing') AND (o.next_retry_at IS NULL OR o.next_retry_at<=now())
        AND (o.processing_until IS NULL OR o.processing_until<now()) AND rp.status IN ('active','completed')
       ORDER BY o.scheduled_for,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`);
    const row=selected.rows[0];
    if(!row){await client.query('COMMIT');return null;}
    const attemptNumber=row.status==='processing'?row.attempt_count:row.attempt_count+1;
    const idempotencyKey=`recurring-${row.recurring_payment_id}-${row.id}-${attemptNumber}`;
    await client.query('INSERT INTO recurring_payment_attempts (occurrence_id,attempt_number,idempotency_key) VALUES ($1,$2,$3) ON CONFLICT (occurrence_id,attempt_number) DO NOTHING',[row.id,attemptNumber,idempotencyKey]);
    await client.query("UPDATE recurring_payment_occurrences SET status='processing',attempt_count=$2,processing_until=now()+interval '2 minutes' WHERE id=$1",[row.id,attemptNumber]);
    await client.query('COMMIT');
    return {...row,attemptNumber,idempotencyKey};
  } catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
}

async function recurringActor(userId:string):Promise<AuthenticatedUser|null>{
  const result=await query<{id:string;email:string;roles:string[]}>(`SELECT u.id,u.email,COALESCE(array_agg(r.name) FILTER(WHERE r.name IS NOT NULL),'{}') AS roles FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE u.id=$1 AND u.status='active' GROUP BY u.id`,[userId]);
  const row=result.rows[0]; return row?{id:row.id,email:row.email,roles:row.roles as AuthenticatedUser['roles'],sessionId:'scheduled-payment-worker'}:null;
}

async function finishRecurring(claim:NonNullable<Awaited<ReturnType<typeof claimRecurring>>>,result:{status:number;body:Record<string,unknown>}|null,errorCode?:string){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const owner=await client.query<{owner_user_id:string;retry_limit:number;retry_delay_minutes:number;frequency:RecurringFrequency;scheduled_for:Date;ends_at:Date|null}>('SELECT rp.owner_user_id,rp.retry_limit,rp.retry_delay_minutes,rp.frequency,o.scheduled_for,rp.ends_at FROM recurring_payment_occurrences o JOIN recurring_payments rp ON rp.id=o.recurring_payment_id WHERE o.id=$1 FOR UPDATE OF o',[claim.id]);
    const policy=owner.rows[0]; const tx=(result?.body.transaction??{}) as {id?:string}; const refused=result?.body.error as {code?:string}|undefined; const code=errorCode??refused?.code??'EXECUTION_FAILED';
    if(result?.status===201&&tx.id){
      await client.query("UPDATE recurring_payment_attempts SET status='succeeded',transaction_id=$2,response_status=$3,completed_at=now() WHERE occurrence_id=$1 AND attempt_number=$4",[claim.id,tx.id,result.status,claim.attemptNumber]);
      await client.query("UPDATE recurring_payment_occurrences SET status='succeeded',transaction_id=$2,processing_until=NULL,completed_at=now(),last_error_code=NULL WHERE id=$1",[claim.id,tx.id]);
      if(policy.ends_at && advanceScheduleDate(policy.scheduled_for,policy.frequency)>policy.ends_at) await client.query("UPDATE recurring_payments SET status='completed',updated_at=now() WHERE id=$1",[claim.recurring_payment_id]);
      await audit(client,policy.owner_user_id,'RECURRING_PAYMENT_EXECUTED','recurring_payment',claim.recurring_payment_id,{occurrenceId:claim.id,transactionId:tx.id,attempt:claim.attemptNumber},undefined);
    } else {
      const retryable=code==='INSUFFICIENT_FUNDS'||result===null||(result?.status??500)>=500; const canRetry=retryable&&claim.attemptNumber<=policy.retry_limit;
      await client.query('UPDATE recurring_payment_attempts SET status=$3,response_status=$4,error_code=$5,completed_at=now() WHERE occurrence_id=$1 AND attempt_number=$2',[claim.id,claim.attemptNumber,canRetry?'retryable_failure':'terminal_failure',result?.status??500,code]);
      await client.query(`UPDATE recurring_payment_occurrences SET status=$2,processing_until=NULL,next_retry_at=CASE WHEN $2='pending' THEN now()+($3*interval '1 minute') ELSE NULL END,last_error_code=$4,completed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1`,[claim.id,canRetry?'pending':'failed',policy.retry_delay_minutes,code]);
      await audit(client,policy.owner_user_id,canRetry?'RECURRING_PAYMENT_RETRY_QUEUED':'RECURRING_PAYMENT_FAILED','recurring_payment',claim.recurring_payment_id,{occurrenceId:claim.id,errorCode:code,attempt:claim.attemptNumber},undefined);
      if(!canRetry && policy.ends_at && advanceScheduleDate(policy.scheduled_for,policy.frequency)>policy.ends_at) await client.query("UPDATE recurring_payments SET status='completed',updated_at=now() WHERE id=$1",[claim.recurring_payment_id]);
    }
    await client.query('COMMIT');
  } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}

export async function pollRecurringPayments(maxExecutions=10):Promise<number>{
  await dueReminders(); await makeDueOccurrences(); let processed=0;
  for(let i=0;i<maxExecutions;i+=1){
    const claim=await claimRecurring(); if(!claim)break;
    let result:{status:number;body:Record<string,unknown>}|null=null; let errorCode:string|undefined;
    try{const actor=await recurringActor(claim.owner_user_id);if(!actor)errorCode='SCHEDULE_OWNER_UNAVAILABLE';else result=await executeOperation({operation:'transfer',accountId:claim.source_account_id,destinationAccountId:claim.destination_account_id,amountPaise:BigInt(claim.amount_paise),idempotencyKey:claim.idempotencyKey,actor});}
    catch(error){errorCode=error instanceof AppError?error.code:'EXECUTION_ERROR';}
    await finishRecurring(claim,result,errorCode); processed+=1;
  }
  return processed;
}
