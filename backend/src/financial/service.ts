import crypto from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { audit } from './audit.js';
import { fingerprint } from './canonical.js';
import type { OperationInput, OperationResult } from './types.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { config } from '../config.js';

interface AccountRow { id: string; kind: 'customer' | 'system'; status: 'active' | 'frozen' | 'closed'; currency: string; balance_paise: string; owner_user_id: string | null; }
interface IdempotencyRow { id: string; request_hash: string; response_status: number | null; response_body: Record<string, unknown> | null; }

function refusedBody(code: string, message: string): Record<string, unknown> { return { error: { code, message } }; }

async function lockAccounts(client: pg.PoolClient, ids: string[]): Promise<Map<string, AccountRow>> {
  const ordered = [...new Set(ids)].sort();
  const result = await client.query<AccountRow>('SELECT id, kind, status, currency, balance_paise, owner_user_id FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ordered]);
  return new Map(result.rows.map(row => [row.id, row]));
}

async function permitted(client: pg.PoolClient, account: AccountRow, actor: OperationInput['actor'], permission: string): Promise<boolean> {
  if (actor.roles.includes('ADMIN') || account.owner_user_id === actor.id) return true;
  const result = await client.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM account_permissions WHERE account_id = $1 AND user_id = $2 AND permission = $3)', [account.id, actor.id, permission]);
  return result.rows[0].exists;
}

async function refusal(client: pg.PoolClient, input: OperationInput, keyId: string, code: string, message: string): Promise<OperationResult> {
  const body = refusedBody(code, message);
  await client.query('INSERT INTO transaction_attempts (user_id, status, reason_code, amount_paise, operation) VALUES ($1, \'refused\', $2, $3, $4)', [input.actor.id, code, input.amountPaise.toString(), input.operation]);
  await client.query('UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE id = $1', [keyId, 422, JSON.stringify(body)]);
  await audit(client, input.actor.id, 'TRANSACTION_REFUSED', 'account', input.accountId, { operation: input.operation, reason: code, amountPaise: input.amountPaise.toString() }, input.correlationId);
  return { status: 422, body };
}

async function dailyTotal(client: pg.PoolClient, accountId: string, incoming: boolean): Promise<bigint> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(CASE WHEN $2::boolean THEN GREATEST(le.amount_paise, 0) ELSE GREATEST(-le.amount_paise, 0) END), 0)::text AS total
     FROM ledger_entries le JOIN ledger_transactions lt ON lt.id = le.transaction_id
     WHERE le.account_id = $1 AND lt.status IN ('posted', 'reversed') AND le.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [accountId, incoming]
  );
  return BigInt(result.rows[0].total);
}

export async function executeOperation(input: OperationInput): Promise<OperationResult> {
  const requestHash = fingerprint({ operation: input.operation, accountId: input.accountId, destinationAccountId: input.destinationAccountId ?? null, amountPaise: input.amountPaise.toString() });
  return withTransaction(async client => {
    const claimed = await client.query<IdempotencyRow>(
      `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING id, request_hash, response_status, response_body`,
      [input.actor.id, input.idempotencyKey, requestHash]
    );
    let idempotency = claimed.rows[0];
    if (!idempotency) {
      const existing = await client.query<IdempotencyRow>('SELECT id, request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE', [input.actor.id, input.idempotencyKey]);
      idempotency = existing.rows[0];
      if (!idempotency || idempotency.request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different request');
      if (idempotency.response_body && idempotency.response_status) return { status: idempotency.response_status, body: idempotency.response_body };
    }
    const ids = input.operation === 'transfer' ? [input.accountId, input.destinationAccountId!] : [input.accountId];
    const accounts = await lockAccounts(client, ids);
    const source = accounts.get(input.accountId);
    const destination = input.destinationAccountId ? accounts.get(input.destinationAccountId) : undefined;
    if (!source || (input.operation === 'transfer' && !destination)) return refusal(client, input, idempotency.id, 'ACCOUNT_NOT_FOUND', 'Account not found');
    if (input.operation === 'transfer' && input.accountId === input.destinationAccountId) return refusal(client, input, idempotency.id, 'SAME_ACCOUNT', 'Source and destination accounts must differ');
    if (source.kind !== 'customer' || (destination && destination.kind !== 'customer')) return refusal(client, input, idempotency.id, 'INVALID_ACCOUNT', 'The operation requires customer accounts');
    if (!await permitted(client, source, input.actor, input.operation === 'deposit' ? 'deposit' : input.operation === 'withdrawal' ? 'withdraw' : 'transfer')) return refusal(client, input, idempotency.id, 'FORBIDDEN', 'You do not have permission to operate this account');
    if (source.status !== 'active' || (destination && destination.status !== 'active')) return refusal(client, input, idempotency.id, 'ACCOUNT_UNAVAILABLE', 'An account is frozen or closed');
    if (source.currency !== 'INR' || destination?.currency && destination.currency !== source.currency) return refusal(client, input, idempotency.id, 'CURRENCY_MISMATCH', 'Accounts must use the same currency');
    const debit = input.operation !== 'deposit';
    if (debit && BigInt(source.balance_paise) < input.amountPaise) return refusal(client, input, idempotency.id, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
    const limits = await client.query<{ daily_debit_limit_paise: string; daily_credit_limit_paise: string }>('SELECT daily_debit_limit_paise, daily_credit_limit_paise FROM account_limits WHERE account_id = $1', [source.id]);
    if (limits.rows[0]) {
      const current = await dailyTotal(client, source.id, !debit);
      const limit = BigInt(debit ? limits.rows[0].daily_debit_limit_paise : limits.rows[0].daily_credit_limit_paise);
      if (current + input.amountPaise > limit) return refusal(client, input, idempotency.id, 'DAILY_LIMIT_EXCEEDED', 'The account transaction limit was exceeded');
    }
    if (input.operation === 'transfer' && input.amountPaise > config.HIGH_VALUE_THRESHOLD_PAISE && !input.actor.roles.includes('ADMIN')) {
      const pendingId = crypto.randomUUID();
      const pendingReference = `LL_PENDING_${pendingId.replaceAll('-', '')}`;
      await client.query(
        `INSERT INTO ledger_transactions (id, reference, status, currency, idempotency_key_id, initiated_by, transaction_type, approval_status, source_account_id, destination_account_id, amount_paise)
         VALUES ($1, $2, 'pending', $3, $4, $5, 'transfer', 'pending', $6, $7, $8)`,
        [pendingId, pendingReference, source.currency, idempotency.id, input.actor.id, source.id, destination!.id, input.amountPaise.toString()]
      );
      await client.query('INSERT INTO transaction_attempts (transaction_id, user_id, status, reason_code, amount_paise, operation) VALUES ($1, $2, \'accepted\', \'HIGH_VALUE_APPROVAL_REQUIRED\', $3, \'transfer\')', [pendingId, input.actor.id, input.amountPaise.toString()]);
      await client.query('UPDATE idempotency_keys SET transaction_id = $2, response_status = 202, response_body = $3 WHERE id = $1', [idempotency.id, pendingId, JSON.stringify({ transaction: { id: pendingId, reference: pendingReference, type: 'transfer', status: 'pending', approvalStatus: 'pending', amountPaise: input.amountPaise.toString() } })]);
      await audit(client, input.actor.id, 'TRANSACTION_PENDING_APPROVAL', 'ledger_transaction', pendingId, { reason: 'HIGH_VALUE_APPROVAL_REQUIRED', amountPaise: input.amountPaise.toString() }, input.correlationId);
      return { status: 202, body: { transaction: { id: pendingId, reference: pendingReference, type: 'transfer', status: 'pending', approvalStatus: 'pending', amountPaise: input.amountPaise.toString() } } };
    }
    const transactionId = crypto.randomUUID();
    const reference = `LL_${transactionId.replaceAll('-', '')}`;
    await client.query(
      `INSERT INTO ledger_transactions (id, reference, status, currency, idempotency_key_id, initiated_by, transaction_type, posted_at)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, NULL)`,
      [transactionId, reference, source.currency, idempotency.id, input.actor.id, input.operation]
    );
    const legs: Array<[string, bigint]> = input.operation === 'transfer'
      ? [[source.id, -input.amountPaise], [destination!.id, input.amountPaise]]
      : input.operation === 'deposit'
        ? [[source.id, input.amountPaise]]
        : [[source.id, -input.amountPaise]];
    if (input.operation === 'deposit') {
      const clearing = await client.query<AccountRow>("SELECT id, kind, status, currency, balance_paise, owner_user_id FROM accounts WHERE code = 'SYSTEM_CLEARING_IN' FOR UPDATE");
      if (!clearing.rows[0]) throw new AppError(500, 'CLEARING_ACCOUNT_MISSING', 'Deposit clearing account is not configured');
      legs.push([clearing.rows[0].id, -input.amountPaise]);
    }
    if (input.operation === 'withdrawal') {
      const clearing = await client.query<AccountRow>("SELECT id, kind, status, currency, balance_paise, owner_user_id FROM accounts WHERE code = 'SYSTEM_CLEARING_OUT' FOR UPDATE");
      if (!clearing.rows[0]) throw new AppError(500, 'CLEARING_ACCOUNT_MISSING', 'Withdrawal clearing account is not configured');
      legs.push([clearing.rows[0].id, input.amountPaise]);
    }
    for (const [accountId, amount] of legs) {
      await client.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_paise, currency) VALUES ($1, $2, $3, $4)', [transactionId, accountId, amount.toString(), source.currency]);
      await client.query('UPDATE accounts SET balance_paise = balance_paise + $2, updated_at = now() WHERE id = $1', [accountId, amount.toString()]);
    }
    await client.query("UPDATE ledger_transactions SET status = 'posted', posted_at = now() WHERE id = $1", [transactionId]);
    await client.query('INSERT INTO transaction_attempts (transaction_id, user_id, status, amount_paise, operation) VALUES ($1, $2, \'accepted\', $3, $4)', [transactionId, input.actor.id, input.amountPaise.toString(), input.operation]);
    const body: Record<string, unknown> = { transaction: { id: transactionId, reference, type: input.operation, status: 'posted', amountPaise: input.amountPaise.toString(), sourceAccountId: source.id, destinationAccountId: destination?.id ?? null } };
    await client.query('UPDATE idempotency_keys SET transaction_id = $2, response_status = 201, response_body = $3 WHERE id = $1', [idempotency.id, transactionId, JSON.stringify(body)]);
    await audit(client, input.actor.id, 'TRANSACTION_POSTED', 'ledger_transaction', transactionId, { operation: input.operation, amountPaise: input.amountPaise.toString() }, input.correlationId);
    return { status: 201, body };
  });
}

export async function approveTransaction(transactionId: string, actor: AuthenticatedUser, correlationId?: string): Promise<OperationResult> {
  return withTransaction(async client => {
    const pending = await client.query<{ id: string; status: string; approval_status: string; currency: string; source_account_id: string; destination_account_id: string; amount_paise: string }>('SELECT id, status, approval_status, currency, source_account_id, destination_account_id, amount_paise FROM ledger_transactions WHERE id = $1 FOR UPDATE', [transactionId]);
    if (!pending.rows[0]) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
    if (pending.rows[0].status === 'posted') throw new AppError(409, 'TRANSACTION_ALREADY_POSTED', 'Transaction is already posted');
    if (pending.rows[0].approval_status !== 'pending') throw new AppError(409, 'TRANSACTION_NOT_PENDING', 'Transaction is not awaiting approval');
    const accounts = await lockAccounts(client, [pending.rows[0].source_account_id, pending.rows[0].destination_account_id]);
    const source = accounts.get(pending.rows[0].source_account_id); const destination = accounts.get(pending.rows[0].destination_account_id); const amount = BigInt(pending.rows[0].amount_paise);
    if (!source || !destination || source.status !== 'active' || destination.status !== 'active' || BigInt(source.balance_paise) < amount) {
      await client.query("UPDATE ledger_transactions SET status = 'failed', approval_status = 'rejected', risk_reason = 'APPROVAL_RECHECK_FAILED' WHERE id = $1", [transactionId]);
      await audit(client, actor.id, 'TRANSACTION_APPROVAL_REJECTED', 'ledger_transaction', transactionId, { reason: 'APPROVAL_RECHECK_FAILED' }, correlationId);
      return { status: 422, body: refusedBody('APPROVAL_RECHECK_FAILED', 'The transaction could not pass approval rechecks') };
    }
    const reversalId = transactionId;
    await client.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_paise, currency) VALUES ($1, $2, $3, $4), ($1, $5, $6, $4)', [reversalId, source.id, (-amount).toString(), pending.rows[0].currency, destination.id, amount.toString()]);
    await client.query('UPDATE accounts SET balance_paise = balance_paise - $2, updated_at = now() WHERE id = $1', [source.id, amount.toString()]);
    await client.query('UPDATE accounts SET balance_paise = balance_paise + $2, updated_at = now() WHERE id = $1', [destination.id, amount.toString()]);
    await client.query("UPDATE ledger_transactions SET status = 'posted', approval_status = 'approved', approved_by = $2, posted_at = now() WHERE id = $1", [transactionId, actor.id]);
    const body = { transaction: { id: transactionId, type: 'transfer', status: 'posted', approvalStatus: 'approved', amountPaise: amount.toString(), sourceAccountId: source.id, destinationAccountId: destination.id } };
    await client.query('UPDATE idempotency_keys SET response_status = 201, response_body = $2 WHERE transaction_id = $1', [transactionId, JSON.stringify(body)]);
    await audit(client, actor.id, 'TRANSACTION_APPROVED', 'ledger_transaction', transactionId, { amountPaise: amount.toString() }, correlationId);
    return { status: 201, body };
  });
}

export async function reverseTransaction(transactionId: string, actor: AuthenticatedUser, idempotencyKey: string, correlationId?: string): Promise<OperationResult> {
  const requestHash = fingerprint({ operation: 'reversal', transactionId });
  return withTransaction(async client => {
    const claimed = await client.query<IdempotencyRow>(
      `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING id, request_hash, response_status, response_body`,
      [actor.id, idempotencyKey, requestHash]
    );
    let idempotency = claimed.rows[0];
    if (!idempotency) {
      const existing = await client.query<IdempotencyRow>('SELECT id, request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE', [actor.id, idempotencyKey]);
      idempotency = existing.rows[0];
      if (!idempotency || idempotency.request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different request');
      if (idempotency.response_body && idempotency.response_status) return { status: idempotency.response_status, body: idempotency.response_body };
    }
    const original = await client.query<{ id: string; status: string; currency: string; reference: string; reversal_of: string | null }>('SELECT id, status, currency, reference, reversal_of FROM ledger_transactions WHERE id = $1 FOR UPDATE', [transactionId]);
    if (!original.rows[0]) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
    if (original.rows[0].status !== 'posted') throw new AppError(409, 'TRANSACTION_NOT_REVERSIBLE', 'Only posted transactions can be reversed');
    const entries = await client.query<{ account_id: string; amount_paise: string }>('SELECT account_id, amount_paise FROM ledger_entries WHERE transaction_id = $1 ORDER BY account_id FOR UPDATE', [transactionId]);
    const accounts = await lockAccounts(client, entries.rows.map(entry => entry.account_id));
    for (const entry of entries.rows) {
      const account = accounts.get(entry.account_id);
      if (!account) throw new AppError(409, 'ACCOUNT_NOT_FOUND', 'Transaction account not found');
      const inverse = -BigInt(entry.amount_paise);
      if (account.kind === 'customer' && BigInt(account.balance_paise) + inverse < 0n) throw new AppError(409, 'REVERSAL_WOULD_OVERDRAW', 'The reversal would make a customer balance negative');
    }
    const reversalId = crypto.randomUUID();
    const reference = `LL_REV_${reversalId.replaceAll('-', '')}`;
    await client.query(
      `INSERT INTO ledger_transactions (id, reference, status, currency, idempotency_key_id, initiated_by, transaction_type, reversal_of, posted_at)
       VALUES ($1, $2, 'pending', $3, $4, $5, 'reversal', $6, NULL)`,
      [reversalId, reference, original.rows[0].currency, idempotency.id, actor.id, transactionId]
    );
    for (const entry of entries.rows) {
      const inverse = -BigInt(entry.amount_paise);
      await client.query('INSERT INTO ledger_entries (transaction_id, account_id, amount_paise, currency) VALUES ($1, $2, $3, $4)', [reversalId, entry.account_id, inverse.toString(), original.rows[0].currency]);
      await client.query('UPDATE accounts SET balance_paise = balance_paise + $2, updated_at = now() WHERE id = $1', [entry.account_id, inverse.toString()]);
    }
    await client.query("UPDATE ledger_transactions SET status = 'posted', posted_at = now() WHERE id = $1", [reversalId]);
    await client.query("UPDATE ledger_transactions SET status = 'reversed' WHERE id = $1", [transactionId]);
    await client.query('INSERT INTO transaction_attempts (transaction_id, user_id, status, amount_paise, operation) VALUES ($1, $2, \'accepted\', NULL, \'reversal\')', [reversalId, actor.id]);
    const body: Record<string, unknown> = { transaction: { id: reversalId, reference, type: 'reversal', status: 'posted', reversalOf: transactionId } };
    await client.query('UPDATE idempotency_keys SET transaction_id = $2, response_status = 201, response_body = $3 WHERE id = $1', [idempotency.id, reversalId, JSON.stringify(body)]);
    await audit(client, actor.id, 'TRANSACTION_REVERSED', 'ledger_transaction', transactionId, { reversalTransactionId: reversalId }, correlationId);
    return { status: 201, body };
  });
}

export async function statement(accountId: string, actor: AuthenticatedUser) {
  const result = await queryAccountAccess(accountId, actor);
  if (!result) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  if (!result.allowed) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this account');
  const entries = await (await import('../db/pool.js')).query<{
    entry_id: string; transaction_id: string; reference: string; transaction_type: string; status: string; amount_paise: string; created_at: Date; initiator_email: string | null; counterparty_code: string | null; running_balance: string;
  }>(
    `SELECT le.id AS entry_id, lt.id AS transaction_id, lt.reference, lt.transaction_type, lt.status, le.amount_paise, le.created_at,
            u.email AS initiator_email,
            (SELECT a2.code FROM ledger_entries le2 JOIN accounts a2 ON a2.id = le2.account_id
             WHERE le2.transaction_id = le.transaction_id AND le2.account_id <> le.account_id LIMIT 1) AS counterparty_code,
            SUM(le.amount_paise) OVER (PARTITION BY le.account_id ORDER BY le.created_at, le.id)::text AS running_balance
     FROM ledger_entries le JOIN ledger_transactions lt ON lt.id = le.transaction_id
     LEFT JOIN users u ON u.id = lt.initiated_by
     WHERE le.account_id = $1 ORDER BY le.created_at DESC, le.id DESC LIMIT 500`,
    [accountId]
  );
  const attempts = await (await import('../db/pool.js')).query<{ id: string; status: string; reason_code: string | null; amount_paise: string | null; operation: string; created_at: Date; email: string | null }>(
    `SELECT ta.id, ta.status, ta.reason_code, ta.amount_paise, ta.operation, ta.created_at, u.email
     FROM transaction_attempts ta LEFT JOIN users u ON u.id = ta.user_id
     WHERE ta.status <> 'accepted' AND (ta.user_id = $2 OR ta.transaction_id IN (SELECT le.transaction_id FROM ledger_entries le WHERE le.account_id = $1))
     ORDER BY ta.created_at DESC LIMIT 100`, [accountId, actor.id]
  );
  return { accountId, entries: entries.rows.map(entry => ({ ...entry, amountPaise: entry.amount_paise, amount_paise: undefined, createdAt: new Date(entry.created_at).toISOString(), runningBalancePaise: entry.running_balance, initiator: entry.initiator_email, counterparty: entry.counterparty_code })), refusedAttempts: attempts.rows.map(attempt => ({ id: attempt.id, status: attempt.status, reason: attempt.reason_code, amountPaise: attempt.amount_paise, operation: attempt.operation, initiator: attempt.email, createdAt: new Date(attempt.created_at).toISOString() })) };
}

export async function transactionDetail(transactionId: string, actor: AuthenticatedUser) {
  const poolQuery = (await import('../db/pool.js')).query;
  const transaction = await poolQuery<{ id: string; reference: string; status: string; transaction_type: string; amount_paise: string | null; initiated_by: string | null; created_at: Date; posted_at: Date | null }>(
    'SELECT id, reference, status, transaction_type, amount_paise, initiated_by, created_at, posted_at FROM ledger_transactions WHERE id = $1', [transactionId]
  );
  if (!transaction.rows[0]) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
  const access = actor.roles.includes('ADMIN') || actor.roles.includes('AUDITOR') || transaction.rows[0].initiated_by === actor.id || (await poolQuery<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM ledger_entries le JOIN accounts a ON a.id = le.account_id WHERE le.transaction_id = $1 AND a.owner_user_id = $2)', [transactionId, actor.id])).rows[0].exists;
  if (!access) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this transaction');
  const [entries, auditEvents] = await Promise.all([
    poolQuery<{ account_id: string; amount_paise: string; currency: string }>('SELECT account_id, amount_paise, currency FROM ledger_entries WHERE transaction_id = $1 ORDER BY account_id', [transactionId]),
    poolQuery<{ event_type: string; metadata: Record<string, unknown>; created_at: Date }>("SELECT event_type, metadata, created_at FROM audit_events WHERE entity_type = 'ledger_transaction' AND entity_id = $1 ORDER BY created_at ASC", [transactionId])
  ]);
  return { transaction: { ...transaction.rows[0], amountPaise: transaction.rows[0].amount_paise, createdAt: transaction.rows[0].created_at.toISOString(), postedAt: transaction.rows[0].posted_at?.toISOString() ?? null }, entries: entries.rows.map(entry => ({ accountId: entry.account_id, amountPaise: entry.amount_paise, currency: entry.currency })), auditTimeline: auditEvents.rows.map(event => ({ eventType: event.event_type, metadata: event.metadata, createdAt: event.created_at.toISOString() })) };
}

async function queryAccountAccess(accountId: string, actor: AuthenticatedUser) {
  const result = await (await import('../db/pool.js')).query<{ id: string; owner_user_id: string | null; permission: string | null; kind: string; balance_paise: string }>(
    'SELECT a.id, a.owner_user_id, a.kind, a.balance_paise, ap.permission FROM accounts a LEFT JOIN account_permissions ap ON ap.account_id = a.id AND ap.user_id = $2 WHERE a.id = $1', [accountId, actor.id]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, allowed: actor.roles.includes('ADMIN') || actor.roles.includes('AUDITOR') || row.owner_user_id === actor.id || row.permission === 'view' };
}

export async function reconciliation() {
  const poolQuery = (await import('../db/pool.js')).query;
  const result = await poolQuery<{ id: string; code: string; snapshot_balance_paise: string; ledger_balance_paise: string; discrepancy_paise: string }>(
    `SELECT a.id, a.code, a.balance_paise::text AS snapshot_balance_paise,
            COALESCE(SUM(le.amount_paise), 0)::text AS ledger_balance_paise,
            (a.balance_paise - COALESCE(SUM(le.amount_paise), 0))::text AS discrepancy_paise
     FROM accounts a LEFT JOIN ledger_entries le ON le.account_id = a.id
     WHERE a.kind = 'customer' GROUP BY a.id ORDER BY a.code`
  );
  return { generatedAt: new Date().toISOString(), discrepancies: result.rows.filter(row => row.discrepancy_paise !== '0').map(row => ({ accountId: row.id, code: row.code, snapshotBalancePaise: row.snapshot_balance_paise, ledgerBalancePaise: row.ledger_balance_paise, discrepancyPaise: row.discrepancy_paise })), accountsChecked: result.rowCount ?? 0 };
}

export async function riskAlerts() {
  const result = await (await import('../db/pool.js')).query<{ id: string; user_id: string | null; operation: string; status: string; reason_code: string | null; amount_paise: string | null; created_at: Date }>('SELECT id, user_id, operation, status, reason_code, amount_paise, created_at FROM transaction_attempts WHERE status <> \'accepted\' ORDER BY created_at DESC LIMIT 100');
  return result.rows.map(row => ({ id: row.id, userId: row.user_id, operation: row.operation, status: row.status, reason: row.reason_code, amountPaise: row.amount_paise, createdAt: new Date(row.created_at).toISOString() }));
}

export async function auditVerification() {
  const poolQuery = (await import('../db/pool.js')).query;
  const result = await poolQuery<{ id: string; previous_hash: string | null; event_hash: string | null; calculated_hash: string | null }>(`SELECT id, previous_hash, event_hash, encode(digest(COALESCE(previous_hash, '') || '|' || event_type || '|' || entity_type || '|' || COALESCE(entity_id::text, '') || '|' || metadata::text || '|' || created_at::text, 'sha256'), 'hex') AS calculated_hash FROM audit_events ORDER BY created_at, id`);
  let previous: string | null = null; let failure: Record<string, unknown> | null = null;
  for (const event of result.rows) {
    if (!event.event_hash || event.previous_hash !== previous || event.event_hash !== event.calculated_hash) { failure = { eventId: event.id, reason: !event.event_hash ? 'MISSING_HASH' : event.previous_hash !== previous ? 'CHAIN_LINK_MISMATCH' : 'HASH_MISMATCH' }; break; }
    previous = event.event_hash;
  }
  return { valid: failure === null, eventsChecked: result.rows.length, failure };
}

export async function analytics() {
  const poolQuery = (await import('../db/pool.js')).query;
  const result = await poolQuery<{ day: string; operation: string; count: string; amount: string }>(
    `SELECT date_trunc('day', lt.created_at)::date::text AS day, lt.transaction_type AS operation, count(*)::text,
        COALESCE(sum(COALESCE(lt.amount_paise, (SELECT max(abs(le.amount_paise)) FROM ledger_entries le WHERE le.transaction_id = lt.id))), 0)::text AS amount
     FROM ledger_transactions lt WHERE lt.status IN ('posted', 'reversed') GROUP BY 1, 2 ORDER BY 1 DESC LIMIT 366`
  );
  return { daily: result.rows.map(row => ({ day: row.day, operation: row.operation, count: Number(row.count), amountPaise: row.amount })) };
}
