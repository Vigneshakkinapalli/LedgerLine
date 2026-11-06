import argon2 from 'argon2';
import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { query } from '../src/db/pool.js';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const email = (prefix: string) => `${prefix}-${crypto.randomUUID()}@example.test`;

async function register(prefix: string) {
  const response = await request(app).post('/api/v1/auth/register').send({ email: email(prefix), password: 'Financial-password-123!' });
  const account = await query<{ id: string }>('SELECT id FROM accounts WHERE owner_user_id = $1', [response.body.user.id]);
  return { token: response.body.accessToken as string, userId: response.body.user.id as string, accountId: account.rows[0].id };
}

async function admin() {
  const adminEmail = email('financial-admin');
  const hash = await argon2.hash('Financial-admin-123!', { type: argon2.argon2id });
  const user = await query<{ id: string }>('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [adminEmail, hash]);
  const role = await query<{ id: string }>("SELECT id FROM roles WHERE name = 'ADMIN'");
  await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user.rows[0].id, role.rows[0].id]);
  const login = await request(app).post('/api/v1/auth/login').send({ email: adminEmail, password: 'Financial-admin-123!' });
  return login.body.accessToken as string;
}

async function amount(token: string, accountId: string, operation: 'deposit' | 'withdraw', value: string, key: string = crypto.randomUUID()) {
  return request(app).post(`/api/v1/accounts/${accountId}/${operation}`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send({ amountPaise: value });
}

describe.skipIf(!runDbTests).sequential('financial engine integration', () => {
  it('posts balanced deposit, transfer, and withdrawal legs', async () => {
    const source = await register('flow-source');
    const destination = await register('flow-destination');
    expect((await amount(source.token, source.accountId, 'deposit', '5000')).status).toBe(201);
    const transfer = await request(app).post(`/api/v1/accounts/${source.accountId}/transfer`).set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', crypto.randomUUID()).send({ destinationAccountId: destination.accountId, amountPaise: '2000' });
    expect(transfer.status).toBe(201);
    expect((await amount(source.token, source.accountId, 'withdraw', '1000')).status).toBe(201);
    const balances = await query<{ id: string; balance_paise: string }>('SELECT id, balance_paise FROM accounts WHERE id = ANY($1::uuid[])', [[source.accountId, destination.accountId]]);
    expect(Object.fromEntries(balances.rows.map(row => [row.id, row.balance_paise]))).toMatchObject({ [source.accountId]: '2000', [destination.accountId]: '2000' });
    const statement = await request(app).get(`/api/v1/accounts/${source.accountId}/transactions`).set('Authorization', `Bearer ${source.token}`);
    expect(statement.status).toBe(200);
    expect(statement.body.entries).toHaveLength(3);
    expect(statement.body.entries[0]).toEqual(expect.objectContaining({ runningBalancePaise: expect.any(String), initiator: expect.any(String) }));
    expect(statement.body.refusedAttempts).toEqual(expect.any(Array));
    const transaction = await query<{ total: string }>('SELECT COALESCE(SUM(amount_paise), 0)::text AS total FROM ledger_entries WHERE transaction_id = $1', [transfer.body.transaction.id]);
    expect(transaction.rows[0].total).toBe('0');
  });

  it('rejects invalid amounts and insufficient funds', async () => {
    const user = await register('invalid');
    expect((await amount(user.token, user.accountId, 'withdraw', '0')).status).toBe(400);
    expect((await amount(user.token, user.accountId, 'withdraw', '999999')).status).toBe(422);
    const attempt = await query<{ reason_code: string; status: string }>('SELECT reason_code, status FROM transaction_attempts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [user.userId]);
    expect(attempt.rows[0]).toMatchObject({ reason_code: 'INSUFFICIENT_FUNDS', status: 'refused' });
  });

  it('returns the original result for the same idempotency payload and conflicts on reuse', async () => {
    const user = await register('idempotency');
    const key = `idem-${crypto.randomUUID()}`;
    const first = await amount(user.token, user.accountId, 'deposit', '700', key);
    const same = await amount(user.token, user.accountId, 'deposit', '700', key);
    const different = await amount(user.token, user.accountId, 'deposit', '701', key);
    expect(first.status).toBe(201);
    expect(same.status).toBe(201);
    expect(same.body).toEqual(first.body);
    expect(different.status).toBe(409);
    const count = await query<{ count: string }>('SELECT count(*) FROM ledger_transactions WHERE idempotency_key_id = (SELECT id FROM idempotency_keys WHERE user_id = $1 AND key = $2)', [user.userId, key]);
    expect(count.rows[0].count).toBe('1');
  });

  it('serializes concurrent withdrawals so the account cannot overspend', async () => {
    const user = await register('concurrent-withdraw');
    expect((await amount(user.token, user.accountId, 'deposit', '1000')).status).toBe(201);
    const responses = await Promise.all([
      amount(user.token, user.accountId, 'withdraw', '700'),
      amount(user.token, user.accountId, 'withdraw', '700')
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 422]);
    const balance = await query<{ balance_paise: string }>('SELECT balance_paise FROM accounts WHERE id = $1', [user.accountId]);
    expect(balance.rows[0].balance_paise).toBe('300');
  });

  it('serializes concurrent duplicate requests into one posting', async () => {
    const source = await register('concurrent-idem-source');
    const destination = await register('concurrent-idem-destination');
    expect((await amount(source.token, source.accountId, 'deposit', '1000')).status).toBe(201);
    const key = `idem-${crypto.randomUUID()}`;
    const responses = await Promise.all([
      request(app).post(`/api/v1/accounts/${source.accountId}/transfer`).set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', key).send({ destinationAccountId: destination.accountId, amountPaise: '250' }),
      request(app).post(`/api/v1/accounts/${source.accountId}/transfer`).set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', key).send({ destinationAccountId: destination.accountId, amountPaise: '250' })
    ]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    expect(responses[0].body).toEqual(responses[1].body);
    const count = await query<{ count: string }>('SELECT count(*) FROM ledger_transactions WHERE idempotency_key_id = (SELECT id FROM idempotency_keys WHERE user_id = $1 AND key = $2)', [source.userId, key]);
    expect(count.rows[0].count).toBe('1');
  });

  it('enforces freeze and transaction limits through admin controls', async () => {
    const user = await register('controls');
    const adminToken = await admin();
    expect((await request(app).patch(`/api/v1/accounts/${user.accountId}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'frozen' })).status).toBe(204);
    expect((await amount(user.token, user.accountId, 'deposit', '100')).body.error.code).toBe('ACCOUNT_UNAVAILABLE');
    expect((await request(app).patch(`/api/v1/accounts/${user.accountId}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'active' })).status).toBe(204);
    expect((await request(app).put(`/api/v1/accounts/${user.accountId}/limits`).set('Authorization', `Bearer ${adminToken}`).send({ dailyDebitLimitPaise: '50', dailyCreditLimitPaise: '50' })).status).toBe(204);
    expect((await amount(user.token, user.accountId, 'deposit', '51')).body.error.code).toBe('DAILY_LIMIT_EXCEEDED');
  });

  it('rejects mutation of posted ledger entries and preserves rollback on bad destination', async () => {
    const user = await register('immutable');
    const posted = await amount(user.token, user.accountId, 'deposit', '100');
    const entry = await query<{ id: string }>('SELECT id FROM ledger_entries WHERE transaction_id = $1', [posted.body.transaction.id]);
    await expect(query('UPDATE ledger_entries SET amount_paise = 99 WHERE id = $1', [entry.rows[0].id])).rejects.toThrow();
    const before = await query<{ count: string }>('SELECT count(*) FROM ledger_transactions WHERE initiated_by = $1', [user.userId]);
    const bad = await request(app).post(`/api/v1/accounts/${user.accountId}/transfer`).set('Authorization', `Bearer ${user.token}`).set('Idempotency-Key', crypto.randomUUID()).send({ destinationAccountId: crypto.randomUUID(), amountPaise: '10' });
    expect(bad.status).toBe(422);
    const after = await query<{ count: string }>('SELECT count(*) FROM ledger_transactions WHERE initiated_by = $1', [user.userId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('reverses with compensating entries and detects snapshot discrepancies', async () => {
    const user = await register('reversal');
    const adminToken = await admin();
    const posted = await amount(user.token, user.accountId, 'deposit', '100');
    const key = `reverse-${crypto.randomUUID()}`;
    const reversal = await request(app).post(`/api/v1/transactions/${posted.body.transaction.id}/reverse`).set('Authorization', `Bearer ${adminToken}`).set('Idempotency-Key', key).send();
    expect(reversal.status).toBe(201);
    expect((await request(app).post(`/api/v1/transactions/${posted.body.transaction.id}/reverse`).set('Authorization', `Bearer ${adminToken}`).set('Idempotency-Key', key).send()).body).toEqual(reversal.body);
    const balance = await query<{ balance_paise: string }>('SELECT balance_paise FROM accounts WHERE id = $1', [user.accountId]);
    expect(balance.rows[0].balance_paise).toBe('0');
    const original = await query<{ status: string }>('SELECT status FROM ledger_transactions WHERE id = $1', [posted.body.transaction.id]);
    expect(original.rows[0].status).toBe('reversed');
    await query('UPDATE accounts SET balance_paise = 7 WHERE id = $1', [user.accountId]);
    const report = await request(app).get('/api/v1/admin/reconciliation').set('Authorization', `Bearer ${adminToken}`);
    expect(report.status).toBe(200);
    expect(report.body.discrepancies.some((item: { accountId: string }) => item.accountId === user.accountId)).toBe(true);
    await query('UPDATE accounts SET balance_paise = 0 WHERE id = $1', [user.accountId]);
    const audit = await query<{ id: string }>('SELECT id FROM audit_events ORDER BY created_at DESC LIMIT 1');
    await expect(query('DELETE FROM audit_events WHERE id = $1', [audit.rows[0].id])).rejects.toThrow();
  });

  it('holds high-value transfers for explicit admin approval', async () => {
    const source = await register('approval-source');
    const destination = await register('approval-destination');
    const adminToken = await admin();
    expect((await amount(source.token, source.accountId, 'deposit', '10000001')).status).toBe(201);
    const pending = await request(app).post(`/api/v1/accounts/${source.accountId}/transfer`).set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', `approval-${crypto.randomUUID()}`).send({ destinationAccountId: destination.accountId, amountPaise: '10000001' });
    expect(pending.status).toBe(202);
    expect(pending.body.transaction.approvalStatus).toBe('pending');
    const approved = await request(app).post(`/api/v1/transactions/${pending.body.transaction.id}/approve`).set('Authorization', `Bearer ${adminToken}`).send();
    expect(approved.status).toBe(201);
    const balances = await query<{ id: string; balance_paise: string }>('SELECT id, balance_paise FROM accounts WHERE id = ANY($1::uuid[])', [[source.accountId, destination.accountId]]);
    expect(Object.fromEntries(balances.rows.map(row => [row.id, row.balance_paise]))).toMatchObject({ [source.accountId]: '0', [destination.accountId]: '10000001' });
  });
});
