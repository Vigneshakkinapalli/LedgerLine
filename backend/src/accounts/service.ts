import type { AuthenticatedUser } from '../auth/types.js';
import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { z } from 'zod';

export const createAccountInput = z.object({ userId: z.string().uuid(), currency: z.enum(['INR']) }).strict();

export async function getAccount(accountId: string, user: AuthenticatedUser) {
  const result = await query<{
    id: string; code: string; kind: string; status: string; currency: string; balance_paise: string; owner_user_id: string | null; created_at: Date; has_view_permission: boolean;
  }>(
    `SELECT a.id, a.code, a.kind, a.status, a.currency, a.balance_paise, a.owner_user_id, a.created_at,
                 EXISTS (SELECT 1 FROM account_permissions ap WHERE ap.account_id = a.id AND ap.user_id = $2 AND ap.permission = 'view') AS has_view_permission
               FROM accounts a
     WHERE a.id = $1`,
    [accountId, user.id]
  );
  const account = result.rows[0];
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  const privileged = user.roles.includes('ADMIN') || user.roles.includes('AUDITOR');
  const holderAccess = account.owner_user_id === user.id || account.has_view_permission;
  if (!privileged && !holderAccess) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this account');
  return {
    id: account.id,
    code: account.code,
    kind: account.kind,
    status: account.status,
    currency: account.currency,
    balancePaise: account.balance_paise,
    ownerUserId: account.owner_user_id,
    createdAt: new Date(account.created_at).toISOString()
  };
}

export async function listAccounts(user: AuthenticatedUser) {
  const result = await query<{
    id: string; code: string; kind: string; status: string; currency: string; balance_paise: string; owner_user_id: string | null; created_at: Date; email: string | null;
  }>(
    `SELECT DISTINCT a.id, a.code, a.kind, a.status, a.currency, a.balance_paise, a.owner_user_id, a.created_at, u.email
     FROM accounts a LEFT JOIN account_permissions ap ON ap.account_id = a.id AND ap.user_id = $1
     LEFT JOIN users u ON u.id = a.owner_user_id
    WHERE $2 OR a.owner_user_id = $1 OR ap.permission = 'view'
     ORDER BY a.created_at DESC`,
    [user.id, user.roles.includes('ADMIN') || user.roles.includes('AUDITOR')]
  );
  return result.rows.map(account => accountView(account));
}

function accountView(account: { id: string; code: string; kind: string; status: string; currency: string; balance_paise: string; owner_user_id: string | null; created_at: Date; email?: string | null }) {
  const identifier = account.code.replace(/^ACC_/, '').slice(-8).toUpperCase();
  return { id: account.id, code: account.code, displayName: account.email ? `${account.email.split('@')[0]} account` : 'LedgerLine account', maskedIdentifier: `•••• ${identifier}`, kind: account.kind, status: account.status, currency: account.currency, balancePaise: account.balance_paise, ownerUserId: account.owner_user_id, createdAt: new Date(account.created_at).toISOString() };
}

export async function listTransferDestinations(sourceAccountId: string, user: AuthenticatedUser) {
  const source = await query<{ id: string; owner_user_id: string | null; status: string }>('SELECT id, owner_user_id, status FROM accounts WHERE id = $1', [sourceAccountId]);
  if (!source.rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  const hasAccess = user.roles.includes('ADMIN') || source.rows[0].owner_user_id === user.id || (await query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM account_permissions WHERE account_id = $1 AND user_id = $2 AND permission = 'transfer')", [sourceAccountId, user.id])).rows[0].exists;
  if (!hasAccess) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to transfer from this account');
  const result = await query<{ id: string; code: string }>(
    `SELECT a.id, a.code
     FROM accounts a
     WHERE a.id <> $1 AND a.kind = 'customer' AND a.status = 'active' AND a.currency = 'INR'
     ORDER BY a.created_at ASC, a.id ASC`,
    [sourceAccountId]
  );
  return result.rows.map(account => {
    const identifier = account.code.replace(/^ACC_/, '').slice(-8).toUpperCase();
    return { id: account.id, displayName: 'LedgerLine recipient', maskedIdentifier: `•••• ${identifier}` };
  });
}

export async function createAccount(userId: string, currency: 'INR', actor: AuthenticatedUser, correlationId?: string) {
  if (actor.roles.includes('AUDITOR') && !actor.roles.includes('ADMIN')) throw new AppError(403, 'FORBIDDEN', 'Auditors cannot create accounts');
  if (!actor.roles.includes('ADMIN') && actor.id !== userId) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to create this account');
  const existing = await query<{ id: string }>('SELECT id FROM accounts WHERE owner_user_id = $1 AND currency = $2 AND kind = \'customer\'', [userId, currency]);
  if (existing.rows[0]) throw new AppError(409, 'ACCOUNT_EXISTS', 'An account already exists for this currency');
  return withTransaction(async client => {
    const account = await client.query<{ id: string; code: string }>("INSERT INTO accounts (owner_user_id, code, kind, currency) VALUES ($1, $2, 'customer', $3) RETURNING id, code", [userId, `ACC_${crypto.randomUUID().replaceAll('-', '')}`, currency]);
    await client.query('INSERT INTO account_limits (account_id, daily_debit_limit_paise, daily_credit_limit_paise) VALUES ($1, 100000000, 100000000)', [account.rows[0].id]);
    await client.query(`INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id) VALUES ($1, 'ACCOUNT_CREATED', 'account', $2, $3, $4)`, [actor.id, account.rows[0].id, JSON.stringify({ userId, currency }), correlationId ?? null]);
    return account.rows[0];
  });
}

export async function grantPermission(accountId: string, userId: string, permission: string, actor: AuthenticatedUser, correlationId?: string) {
  const result = await query<{ id: string }>('SELECT id FROM accounts WHERE id = $1', [accountId]);
  if (!result.rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  await withTransaction(async client => {
    await client.query('INSERT INTO account_permissions (account_id, user_id, permission) VALUES ($1, $2, $3)', [accountId, userId, permission]);
    await client.query(
      `INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1, 'ACCOUNT_PERMISSION_GRANTED', 'account', $2, $3, $4)`,
      [actor.id, accountId, JSON.stringify({ userId, permission }), correlationId ?? null]
    );
  });
}

export async function updateAccountStatus(accountId: string, status: 'active' | 'frozen' | 'closed', actor: AuthenticatedUser, correlationId?: string) {
  await withTransaction(async client => {
    const result = await client.query<{ id: string }>('UPDATE accounts SET status = $2, updated_at = now() WHERE id = $1 RETURNING id', [accountId, status]);
    if (!result.rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    await client.query(
      `INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1, 'ACCOUNT_STATUS_UPDATED', 'account', $2, $3, $4)`,
      [actor.id, accountId, JSON.stringify({ status }), correlationId ?? null]
    );
  });
}

export async function setAccountLimits(accountId: string, debit: string, credit: string, actor: AuthenticatedUser, correlationId?: string) {
  await withTransaction(async client => {
    const result = await client.query<{ id: string }>('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!result.rows[0]) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    await client.query(
      `INSERT INTO account_limits (account_id, daily_debit_limit_paise, daily_credit_limit_paise)
       VALUES ($1, $2, $3) ON CONFLICT (account_id) DO UPDATE SET daily_debit_limit_paise = EXCLUDED.daily_debit_limit_paise, daily_credit_limit_paise = EXCLUDED.daily_credit_limit_paise, updated_at = now()`,
      [accountId, debit, credit]
    );
    await client.query(
      `INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1, 'ACCOUNT_LIMITS_UPDATED', 'account', $2, $3, $4)`,
      [actor.id, accountId, JSON.stringify({ dailyDebitLimitPaise: debit, dailyCreditLimitPaise: credit }), correlationId ?? null]
    );
  });
}
