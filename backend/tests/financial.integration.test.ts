import argon2 from 'argon2';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { query } from '../src/db/pool.js';
import { pollScheduledReconciliation } from '../src/financial/reporting.js';
import { pollScheduledPayments } from '../src/financial/scheduled-payments.js';
import { pollRecurringPayments } from '../src/financial/recurring-payments.js';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const email = (prefix: string) => `${prefix}-${crypto.randomUUID()}@example.test`;

async function register(prefix: string) {
  const response = await request(app).post('/api/v1/auth/register').send({ fullName: `Financial ${prefix}`, email: email(prefix), password: 'Financial-password-123!' });
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
    const deposit = await amount(source.token, source.accountId, 'deposit', '5000');
    expect(deposit.status).toBe(201);
    const transfer = await request(app).post(`/api/v1/accounts/${source.accountId}/transfer`).set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', crypto.randomUUID()).send({ destinationAccountId: destination.accountId, amountPaise: '2000' });
    expect(transfer.status).toBe(201);
    const withdrawal = await amount(source.token, source.accountId, 'withdraw', '1000');
    expect(withdrawal.status).toBe(201);
    const balances = await query<{ id: string; balance_paise: string }>('SELECT id, balance_paise FROM accounts WHERE id = ANY($1::uuid[])', [[source.accountId, destination.accountId]]);
    expect(Object.fromEntries(balances.rows.map(row => [row.id, row.balance_paise]))).toMatchObject({ [source.accountId]: '2000', [destination.accountId]: '2000' });
    expect(balances.rows.reduce((total, row) => total + BigInt(row.balance_paise), 0n)).toBe(4000n); // 5000 external credit - 1000 external debit; transfer nets to zero.
    const statement = await request(app).get(`/api/v1/accounts/${source.accountId}/transactions`).set('Authorization', `Bearer ${source.token}`);
    expect(statement.status).toBe(200);
    expect(statement.body.entries).toHaveLength(3);
    expect(statement.body.entries[0]).toEqual(expect.objectContaining({ runningBalancePaise: expect.any(String), initiator: expect.any(String) }));
    expect(statement.body.refusedAttempts).toEqual(expect.any(Array));
    const transactions = await query<{ transaction_id: string; total: string }>('SELECT transaction_id, SUM(amount_paise)::text AS total FROM ledger_entries WHERE transaction_id = ANY($1::uuid[]) GROUP BY transaction_id', [[deposit.body.transaction.id, transfer.body.transaction.id, withdrawal.body.transaction.id]]);
    expect(transactions.rows).toHaveLength(3);
    expect(transactions.rows.every(transaction => transaction.total === '0')).toBe(true);
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

  it('serializes distinct-key concurrent transfers without double spending', async () => {
    const source = await register('concurrent-transfer-source');
    const firstDestination = await register('concurrent-transfer-a');
    const secondDestination = await register('concurrent-transfer-b');
    expect((await amount(source.token, source.accountId, 'deposit', '1000')).status).toBe(201);
    const transfer = (destinationAccountId: string) => request(app)
      .post(`/api/v1/accounts/${source.accountId}/transfer`)
      .set('Authorization', `Bearer ${source.token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ destinationAccountId, amountPaise: '700' });
    const responses = await Promise.all([transfer(firstDestination.accountId), transfer(secondDestination.accountId)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 422]);
    const balances = await query<{ id: string; balance_paise: string }>('SELECT id, balance_paise FROM accounts WHERE id = ANY($1::uuid[])', [[source.accountId, firstDestination.accountId, secondDestination.accountId]]);
    const byId = Object.fromEntries(balances.rows.map(row => [row.id, row.balance_paise]));
    expect(byId[source.accountId]).toBe('300');
    expect([byId[firstDestination.accountId], byId[secondDestination.accountId]].filter(value => value === '700')).toHaveLength(1);
    expect([byId[firstDestination.accountId], byId[secondDestination.accountId]].filter(value => value === '0')).toHaveLength(1);
    const postedTotals = await query<{ total: string }>("SELECT COALESCE(SUM(le.amount_paise), 0)::text AS total FROM ledger_entries le JOIN ledger_transactions lt ON lt.id = le.transaction_id WHERE lt.transaction_type = 'transfer' AND lt.initiated_by = $1 AND lt.status = 'posted'", [source.userId]);
    expect(postedTotals.rows[0].total).toBe('0');
  });

  it('rejects unauthorized writes without changing either account ledger', async () => {
    const victim = await register('unauthorized-victim');
    const attacker = await register('unauthorized-attacker');
    expect((await amount(victim.token, victim.accountId, 'deposit', '100')).status).toBe(201);
    const before = await query<{ count: string }>('SELECT count(*) FROM ledger_entries WHERE account_id = $1', [victim.accountId]);
    const unauthorized = [
      amount(attacker.token, victim.accountId, 'deposit', '10'),
      amount(attacker.token, victim.accountId, 'withdraw', '10'),
      request(app).post(`/api/v1/accounts/${victim.accountId}/transfer`).set('Authorization', `Bearer ${attacker.token}`).set('Idempotency-Key', crypto.randomUUID()).send({ destinationAccountId: attacker.accountId, amountPaise: '10' })
    ];
    for (const response of await Promise.all(unauthorized)) {
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
    const after = await query<{ count: string }>('SELECT count(*) FROM ledger_entries WHERE account_id = $1', [victim.accountId]);
    const balances = await query<{ id: string; balance_paise: string }>('SELECT id, balance_paise FROM accounts WHERE id = ANY($1::uuid[])', [[victim.accountId, attacker.accountId]]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(Object.fromEntries(balances.rows.map(row => [row.id, row.balance_paise]))).toMatchObject({ [victim.accountId]: '100', [attacker.accountId]: '0' });
    const refused = await query<{ count: string }>("SELECT count(*) FROM transaction_attempts WHERE user_id = $1 AND account_id = $2 AND status = 'refused' AND reason_code = 'FORBIDDEN'", [attacker.userId, victim.accountId]);
    expect(refused.rows[0].count).toBe('3');
  });

  it('paginates a statement with account-scoped refused attempts and unchanged balances', async () => {
    const user = await register('statement-pages');
    expect((await amount(user.token, user.accountId, 'deposit', '100')).status).toBe(201);
    expect((await amount(user.token, user.accountId, 'withdraw', '150')).status).toBe(422);
    const legacyAttemptId = crypto.randomUUID();
    const latestEntryTime = await query<{ created_at: Date }>('SELECT max(created_at) AS created_at FROM ledger_entries WHERE account_id=$1', [user.accountId]);
    const legacyCreatedAt = new Date(new Date(latestEntryTime.rows[0].created_at).getTime() + 1000);
    const legacyMetadata = { operation: 'withdrawal', reason: 'LEGACY_REFUSED', amountPaise: '125' };
    await query(
      `INSERT INTO audit_events (actor_user_id,event_type,entity_type,entity_id,metadata,created_at)
       VALUES ($1,'TRANSACTION_REFUSED','account',$2,$3,$4)`,
      [user.userId, user.accountId, JSON.stringify(legacyMetadata), legacyCreatedAt]
    );
    await query(
      `INSERT INTO transaction_attempts (id,user_id,status,reason_code,amount_paise,operation,created_at)
       VALUES ($1,$2,'refused','LEGACY_REFUSED',125,'withdrawal',$3)`,
      [legacyAttemptId, user.userId, legacyCreatedAt]
    );
    await query(await readFile(new URL('../../database/migrations/010_backfill_refused_attempt_accounts.sql', import.meta.url), 'utf8'));
    const legacyAccount = await query<{ account_id: string | null }>('SELECT account_id FROM transaction_attempts WHERE id=$1', [legacyAttemptId]);
    expect(legacyAccount.rows[0].account_id).toBe(user.accountId);
    const first = await request(app).get(`/api/v1/accounts/${user.accountId}/transactions?page=1&pageSize=1`).set('Authorization', `Bearer ${user.token}`);
    const second = await request(app).get(`/api/v1/accounts/${user.accountId}/transactions?page=2&pageSize=1`).set('Authorization', `Bearer ${user.token}`);
    const third = await request(app).get(`/api/v1/accounts/${user.accountId}/transactions?page=3&pageSize=1`).set('Authorization', `Bearer ${user.token}`);
    expect(first.status).toBe(200);
    expect(first.body.pagination).toEqual({ page: 1, pageSize: 1, totalRecords: 3, totalPages: 3 });
    expect(first.body.items).toHaveLength(1);
    const statementItems = [...first.body.items, ...second.body.items, ...third.body.items];
    expect(statementItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'refused_attempt', reason: 'LEGACY_REFUSED', amountPaise: '125', initiator: expect.any(String), createdAt: expect.any(String), runningBalancePaise: '100' }),
      expect.objectContaining({ type: 'refused_attempt', reason: 'INSUFFICIENT_FUNDS', amountPaise: '150', initiator: expect.any(String), createdAt: expect.any(String), runningBalancePaise: '100' }),
      expect.objectContaining({ type: 'entry', amountPaise: '100', initiator: expect.any(String), createdAt: expect.any(String), runningBalancePaise: '100' })
    ]));
    expect(statementItems.filter((item: { type: string }) => item.type === 'entry')).toHaveLength(1);
    await expect(request(app).get(`/api/v1/accounts/${user.accountId}/transactions?page=0&pageSize=101`).set('Authorization', `Bearer ${user.token}`)).resolves.toMatchObject({ status: 400 });
  });

  it('calculates authorized analytics from filtered persisted ledger records', async () => {
    const user = await register('analytics-source');
    expect((await amount(user.token, user.accountId, 'deposit', '2000')).status).toBe(201);
    expect((await amount(user.token, user.accountId, 'withdraw', '500')).status).toBe(201);
    const adminToken = await admin();
    const today = new Date().toISOString().slice(0, 10);
    const response = await request(app).get(`/api/v1/analytics?startDate=${today}&endDate=${today}&accountId=${user.accountId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    expect(response.body.kpis).toMatchObject({ deposits: '2000', withdrawals: '500', transaction_count: '2', successful_count: '2', active_accounts: '1' });
    expect(response.body.trends).toHaveLength(1);
    expect(response.body.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ id: user.accountId, balance_paise: '1500' })]));
    const filtered = await request(app).get(`/api/v1/analytics?startDate=${today}&endDate=${today}&accountId=${user.accountId}&transactionType=deposit`).set('Authorization', `Bearer ${adminToken}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.kpis).toMatchObject({ deposits: '2000', withdrawals: '0', transaction_count: '1' });
    expect((await request(app).get('/api/v1/analytics?startDate=2026-02-31&endDate=2026-03-01').set('Authorization', `Bearer ${adminToken}`)).status).toBe(400);
  });

  it('persists reconciliation findings and requires a different admin to resolve without changing the ledger', async () => {
    const user = await register('reconciliation-history');
    expect((await amount(user.token, user.accountId, 'deposit', '100')).status).toBe(201);
    const adminToken = await admin();
    const secondAdminToken = await admin();
    expect((await request(app).post('/api/v1/admin/reconciliation/run').set('Authorization', `Bearer ${user.token}`).send()).status).toBe(403);
    await query('UPDATE accounts SET balance_paise = 107 WHERE id = $1', [user.accountId]);
    const beforeEntries = await query<{ count: string }>('SELECT count(*) FROM ledger_entries WHERE account_id = $1', [user.accountId]);
    const run = await request(app).post('/api/v1/admin/reconciliation/run').set('Authorization', `Bearer ${adminToken}`).send();
    expect(run.status).toBe(201);
    expect(run.body.discrepancyCount).toBeGreaterThan(0);
    const history = await request(app).get('/api/v1/admin/reconciliation/history?page=1&pageSize=10').set('Authorization', `Bearer ${adminToken}`);
    expect(history.status).toBe(200);
    expect(history.body.runs[0].id).toBe(run.body.id);
    const findings = await request(app).get(`/api/v1/admin/reconciliation/runs/${run.body.id}/findings`).set('Authorization', `Bearer ${adminToken}`);
    const finding = findings.body.findings.find((item: { finding_type: string; account_id: string }) => item.finding_type === 'BALANCE_MISMATCH' && item.account_id === user.accountId);
    expect(finding).toBeTruthy();
    expect((await request(app).patch(`/api/v1/admin/reconciliation/findings/${finding.id}`).set('Authorization', `Bearer ${user.token}`).send({ status: 'investigating', resolutionNote: 'Unauthorized attempt' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/reconciliation/findings/${finding.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'resolved', resolutionNote: 'Cannot skip investigation' })).body.error.code).toBe('INVESTIGATION_REQUIRED');
    expect((await request(app).patch(`/api/v1/admin/reconciliation/findings/${finding.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'investigating', resolutionNote: 'Investigating snapshot drift' })).status).toBe(200);
    const makerChecker = await request(app).patch(`/api/v1/admin/reconciliation/findings/${finding.id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'resolved', resolutionNote: 'Recorded investigation outcome' });
    expect(makerChecker.status).toBe(409);
    expect(makerChecker.body.error.code).toBe('MAKER_CHECKER_REQUIRED');
    const resolved = await request(app).patch(`/api/v1/admin/reconciliation/findings/${finding.id}`).set('Authorization', `Bearer ${secondAdminToken}`).send({ status: 'resolved', resolutionNote: 'Approved the investigation record; no ledger correction' });
    expect(resolved.status).toBe(200);
    expect((await request(app).patch(`/api/v1/admin/reconciliation/findings/${finding.id}`).set('Authorization', `Bearer ${secondAdminToken}`).send({ status: 'investigating', resolutionNote: 'Cannot rewrite resolution' })).body.error.code).toBe('FINDING_ALREADY_RESOLVED');
    const afterEntries = await query<{ count: string }>('SELECT count(*) FROM ledger_entries WHERE account_id = $1', [user.accountId]);
    const unchangedBalance = await query<{ balance_paise: string }>('SELECT balance_paise FROM accounts WHERE id = $1', [user.accountId]);
    expect(afterEntries.rows[0].count).toBe(beforeEntries.rows[0].count);
    expect(unchangedBalance.rows[0].balance_paise).toBe('107');
    await query('UPDATE accounts SET balance_paise = 100 WHERE id = $1', [user.accountId]);
  });

  it('runs a due daily reconciliation schedule only once across concurrent workers', async () => {
    const adminToken = await admin();
    const holder = await register('schedule-holder');
    const configured = await request(app).put('/api/v1/admin/reconciliation/schedule').set('Authorization', `Bearer ${adminToken}`).send({ enabled: true, cadence: 'daily' });
    expect(configured.status).toBe(200);
    expect(configured.body.schedule.enabled).toBe(true);
    await query('UPDATE reconciliation_schedules SET next_run_at = now() - interval \'1 minute\' WHERE schedule_key = 1');
    const results = await Promise.all([pollScheduledReconciliation(), pollScheduledReconciliation()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const runs = await query<{ count: string }>("SELECT count(*) FROM reconciliation_runs WHERE initiated_by = (SELECT updated_by FROM reconciliation_schedules WHERE schedule_key = 1)");
    expect(runs.rows[0].count).toBe('1');
    const schedule = await query<{ next_run_at: Date }>('SELECT next_run_at FROM reconciliation_schedules WHERE schedule_key = 1');
    expect(schedule.rows[0].next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect((await request(app).put('/api/v1/admin/reconciliation/schedule').set('Authorization', `Bearer ${holder.token}`).send({ enabled: false, cadence: 'daily' })).status).toBe(403);
    await request(app).put('/api/v1/admin/reconciliation/schedule').set('Authorization', `Bearer ${adminToken}`).send({ enabled: false, cadence: 'daily' }).expect(200);
  });

  it('retries an insufficient-funds scheduled transfer with a new idempotency attempt and executes once', async () => {
    const source = await register('scheduled-source');
    const destination = await register('scheduled-destination');
    const adminToken = await admin();
    const auditor = await register('scheduled-auditor');
    const grant = await request(app).put(`/api/v1/admin/users/${auditor.userId}/roles`).set('Authorization', `Bearer ${adminToken}`).send({ roles: ['AUDITOR'] });
    expect(grant.status).toBe(200);
    const auditorLogin = await request(app).post('/api/v1/auth/login').send({ email: (await query<{ email: string }>('SELECT email FROM users WHERE id=$1', [auditor.userId])).rows[0].email, password: 'Financial-password-123!' });
    const executeAt = new Date(Date.now() + 60_000).toISOString();
    const denied = await request(app).post('/api/v1/scheduled-payments').set('Authorization', `Bearer ${auditorLogin.body.accessToken}`).set('Idempotency-Key', `denied-${crypto.randomUUID()}`).send({ sourceAccountId: source.accountId, destinationAccountId: destination.accountId, amountPaise: '500', executeAt, description: 'rent payment' });
    expect(denied.status).toBe(403);
    const createKey = `create-${crypto.randomUUID()}`;
    const createBody = { sourceAccountId: source.accountId, destinationAccountId: destination.accountId, amountPaise: '500', executeAt, description: 'monthly rent', retryLimit: 2, retryDelayMinutes: 1, reminderMinutes: 60 };
    expect((await request(app).post('/api/v1/scheduled-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', `wrong-kind-${crypto.randomUUID()}`).send({ ...createBody, cadence: 'daily' })).status).toBe(400);
    const created = await request(app).post('/api/v1/scheduled-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', createKey).send(createBody);
    expect(created.status).toBe(201);
    const scheduleId = created.body.schedule.id as string;
    expect(created.body.schedule.cadence).toBe('once');
    expect(created.body.schedule.description).toBe('monthly rent');
    const replay = await request(app).post('/api/v1/scheduled-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', createKey).send(createBody);
    expect(replay.body.schedule.id).toBe(scheduleId);
    const conflict = await request(app).post('/api/v1/scheduled-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', createKey).send({ ...createBody, description: 'different instruction' });
    expect(conflict.status).toBe(409);
    const listed = await request(app).get('/api/v1/scheduled-payments').set('Authorization', `Bearer ${source.token}`);
    expect(listed.body.schedules).toHaveLength(1);
    expect(listed.body.schedules[0]).toEqual(expect.objectContaining({ id: scheduleId, description: 'monthly rent', cadence: 'once' }));
    expect(await pollScheduledPayments()).toBe(0);
    const reminder = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${source.token}`);
    expect(reminder.body.notifications.some((item: { event_type: string; entity_id: string }) => item.event_type === 'SCHEDULED_PAYMENT_REMINDER' && item.entity_id === scheduleId)).toBe(true);
    await query('UPDATE scheduled_payments SET next_run_at=now()-interval \'1 minute\' WHERE id=$1', [scheduleId]);
    expect(await pollScheduledPayments()).toBe(1);
    let occurrence = await query<{ id: string; status: string; attempt_count: number; last_error_code: string }>('SELECT id,status,attempt_count,last_error_code FROM scheduled_payment_occurrences WHERE schedule_id=$1', [scheduleId]);
    expect(occurrence.rows[0]).toMatchObject({ status: 'pending', attempt_count: 1, last_error_code: 'INSUFFICIENT_FUNDS' });
    await expect(pollScheduledPayments()).resolves.toBe(0);
    expect((await amount(source.token, source.accountId, 'deposit', '500')).status).toBe(201);
    await query('UPDATE scheduled_payment_occurrences SET next_retry_at=now()-interval \'1 minute\' WHERE id=$1', [occurrence.rows[0].id]);
    expect(await pollScheduledPayments()).toBe(1);
    occurrence = await query('SELECT id,status,attempt_count,last_error_code FROM scheduled_payment_occurrences WHERE schedule_id=$1', [scheduleId]);
    expect(occurrence.rows[0]).toMatchObject({ status: 'succeeded', attempt_count: 2 });
    const attempts = await query<{ attempt_number: number; idempotency_key: string; status: string }>('SELECT attempt_number,idempotency_key,status FROM scheduled_payment_attempts WHERE occurrence_id=$1 ORDER BY attempt_number', [occurrence.rows[0].id]);
    expect(attempts.rows).toHaveLength(2);
    expect(attempts.rows[0].idempotency_key).not.toBe(attempts.rows[1].idempotency_key);
    expect(attempts.rows.map(item => item.status)).toEqual(['retryable_failure', 'succeeded']);
    const transferCount = await query<{ count: string }>("SELECT count(*) FROM ledger_transactions WHERE initiated_by=$1 AND transaction_type='transfer' AND status='posted'", [source.userId]);
    expect(transferCount.rows[0].count).toBe('1');
    const balances = await query<{ id: string; balance_paise: string }>('SELECT id,balance_paise FROM accounts WHERE id=ANY($1::uuid[])', [[source.accountId,destination.accountId]]);
    expect(Object.fromEntries(balances.rows.map(row=>[row.id,row.balance_paise]))).toMatchObject({ [source.accountId]: '0', [destination.accountId]: '500' });
    const detail = await request(app).get(`/api/v1/scheduled-payments/${scheduleId}`).set('Authorization', `Bearer ${source.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.executions[0].attempts).toHaveLength(2);
    const completedNotification = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${source.token}`);
    expect(completedNotification.body.notifications.some((item: { event_type: string; entity_id: string }) => item.event_type === 'SCHEDULED_PAYMENT_EXECUTED' && item.entity_id === scheduleId)).toBe(true);
  });

  it('creates a separate recurring plan and retries one monthly occurrence without duplicate postings', async () => {
    const source = await register('recurring-retry-source');
    const destination = await register('recurring-retry-destination');
    const startAt = new Date(Date.now() + 60_000).toISOString();
    const key = `recurring-create-${crypto.randomUUID()}`;
    const body = { sourceAccountId: source.accountId, destinationAccountId: destination.accountId, amountPaise: '300', frequency: 'monthly', startAt, description: 'monthly support', retryLimit: 2, retryDelayMinutes: 1, reminderMinutes: 0 };
    const created = await request(app).post('/api/v1/recurring-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', key).send(body);
    expect(created.status).toBe(201);
    const recurringId = created.body.payment.id as string;
    expect(created.body.payment).toEqual(expect.objectContaining({ frequency: 'monthly', description: 'monthly support' }));
    expect((await request(app).post('/api/v1/recurring-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', key).send(body)).body.payment.id).toBe(recurringId);
    const conflict = await request(app).post('/api/v1/recurring-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', key).send({ ...body, description: 'different plan' });
    expect(conflict.status).toBe(409);
    await query('UPDATE recurring_payments SET next_execution_at=now()-interval \'1 minute\' WHERE id=$1', [recurringId]);
    expect(await pollRecurringPayments()).toBe(1);
    let occurrence = await query<{ id: string; status: string; attempt_count: number; last_error_code: string }>('SELECT id,status,attempt_count,last_error_code FROM recurring_payment_occurrences WHERE recurring_payment_id=$1', [recurringId]);
    expect(occurrence.rows[0]).toMatchObject({ status: 'pending', attempt_count: 1, last_error_code: 'INSUFFICIENT_FUNDS' });
    expect((await amount(source.token, source.accountId, 'deposit', '300')).status).toBe(201);
    await query('UPDATE recurring_payment_occurrences SET next_retry_at=now()-interval \'1 minute\' WHERE id=$1', [occurrence.rows[0].id]);
    expect(await pollRecurringPayments()).toBe(1);
    occurrence = await query('SELECT id,status,attempt_count,last_error_code FROM recurring_payment_occurrences WHERE recurring_payment_id=$1', [recurringId]);
    expect(occurrence.rows[0]).toMatchObject({ status: 'succeeded', attempt_count: 2 });
    const attempts = await query<{ idempotency_key: string; status: string }>('SELECT idempotency_key,status FROM recurring_payment_attempts WHERE occurrence_id=$1 ORDER BY attempt_number', [occurrence.rows[0].id]);
    expect(attempts.rows.map(item => item.status)).toEqual(['retryable_failure', 'succeeded']);
    expect(attempts.rows[0].idempotency_key).not.toBe(attempts.rows[1].idempotency_key);
    const transfers = await query<{ count: string }>("SELECT count(*) FROM ledger_transactions WHERE initiated_by=$1 AND transaction_type='transfer' AND status='posted'", [source.userId]);
    expect(transfers.rows[0].count).toBe('1');
  });

  it('rejects high-value recurring instructions instead of bypassing Admin approval', async () => {
    const source = await register('recurring-high-value-source');
    const destination = await register('recurring-high-value-destination');
    const result = await request(app).post('/api/v1/recurring-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', `recurring-high-${crypto.randomUUID()}`).send({ sourceAccountId: source.accountId, destinationAccountId: destination.accountId, amountPaise: '10000001', frequency: 'weekly', startAt: new Date(Date.now() + 60_000).toISOString(), description: 'high value recurring' });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('HIGH_VALUE_SCHEDULE_UNSUPPORTED');
  });

  it('supports authorized pause, resume, cancel and refuses non-owner disclosure', async () => {
    const owner = await register('schedule-actions-owner');
    const other = await register('schedule-actions-other');
    const destination = await register('schedule-actions-destination');
    const executeAt = new Date(Date.now() + 60_000).toISOString();
    const created = await request(app).post('/api/v1/recurring-payments').set('Authorization', `Bearer ${owner.token}`).set('Idempotency-Key', `recurring-${crypto.randomUUID()}`).send({ sourceAccountId: owner.accountId, destinationAccountId: destination.accountId, amountPaise: '10', frequency: 'weekly', startAt: executeAt, description: 'weekly transfer', reminderMinutes: 0 });
    expect(created.status).toBe(201);
    const id = created.body.payment.id as string;
    expect(created.body.payment.frequency).toBe('weekly');
    expect((await request(app).get(`/api/v1/recurring-payments/${id}`).set('Authorization', `Bearer ${other.token}`)).status).toBe(404);
    expect((await request(app).post(`/api/v1/recurring-payments/${id}/actions`).set('Authorization', `Bearer ${owner.token}`).send({ action: 'pause' })).body.payment.status).toBe('paused');
    expect((await request(app).post(`/api/v1/recurring-payments/${id}/actions`).set('Authorization', `Bearer ${owner.token}`).send({ action: 'resume' })).body.payment.status).toBe('active');
    expect((await request(app).post(`/api/v1/recurring-payments/${id}/actions`).set('Authorization', `Bearer ${owner.token}`).send({ action: 'cancel' })).body.payment.status).toBe('cancelled');
  });

  it('executes a selected monthly recurring payment and advances Jan-31 to Feb-28', async () => {
    const source = await register('scheduled-monthly-source');
    const destination = await register('scheduled-monthly-destination');
    expect((await amount(source.token, source.accountId, 'deposit', '100')).status).toBe(201);
    const futureStart = new Date(Date.now() + 60_000);
    const futureEnd = new Date(futureStart.getTime() + 35 * 86_400_000);
    const created = await request(app).post('/api/v1/recurring-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', `monthly-${crypto.randomUUID()}`).send({ sourceAccountId: source.accountId, destinationAccountId: destination.accountId, amountPaise: '10', frequency: 'monthly', startAt: futureStart.toISOString(), endsAt: futureEnd.toISOString(), description: 'monthly test', reminderMinutes: 0 });
    expect(created.status).toBe(201);
    const paymentId = created.body.payment.id as string;
    await query("UPDATE recurring_payments SET next_execution_at='2025-01-31T12:00:00Z',ends_at='2025-02-28T12:00:00Z' WHERE id=$1", [paymentId]);
    expect(await pollRecurringPayments()).toBe(1);
    const schedule = await query<{ status: string; next_execution_at: Date }>('SELECT status,next_execution_at FROM recurring_payments WHERE id=$1', [paymentId]);
    expect(schedule.rows[0].status).toBe('active');
    expect(schedule.rows[0].next_execution_at.toISOString()).toBe('2025-02-28T12:00:00.000Z');
    const occurrences = await query<{ count: string }>('SELECT count(*) FROM recurring_payment_occurrences WHERE recurring_payment_id=$1', [paymentId]);
    expect(occurrences.rows[0].count).toBe('1');
    await query("UPDATE recurring_payments SET next_execution_at=('2025-02-28T12:00:00Z'::timestamptz - interval '1 second') WHERE id=$1", [paymentId]);
    expect(await pollRecurringPayments()).toBe(1);
    const completed = await query<{ status: string }>('SELECT status FROM recurring_payments WHERE id=$1', [paymentId]);
    expect(completed.rows[0].status).toBe('completed');
    const finalOccurrences = await query<{ count: string }>('SELECT count(*) FROM recurring_payment_occurrences WHERE recurring_payment_id=$1', [paymentId]);
    expect(finalOccurrences.rows[0].count).toBe('2');
    expect(await pollRecurringPayments()).toBe(0);
  });

  it('does not duplicate a scheduled transfer when workers poll the same due occurrence concurrently', async () => {
    const source = await register('scheduled-race-source');
    const destination = await register('scheduled-race-destination');
    expect((await amount(source.token, source.accountId, 'deposit', '1000')).status).toBe(201);
    const executeAt = new Date(Date.now() + 60_000).toISOString();
    const created = await request(app).post('/api/v1/scheduled-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', `worker-race-${crypto.randomUUID()}`).send({ sourceAccountId: source.accountId, destinationAccountId: destination.accountId, amountPaise: '250', executeAt, description: 'worker race', reminderMinutes: 0 });
    expect(created.status).toBe(201);
    await query('UPDATE scheduled_payments SET next_run_at=now()-interval \'1 minute\' WHERE id=$1', [created.body.schedule.id]);
    const processed = await Promise.all([pollScheduledPayments(), pollScheduledPayments()]);
    expect(processed.reduce((sum, count) => sum + count, 0)).toBe(1);
    const transactionCount = await query<{ count: string }>("SELECT count(*) FROM ledger_transactions WHERE initiated_by=$1 AND transaction_type='transfer' AND status='posted'", [source.userId]);
    expect(transactionCount.rows[0].count).toBe('1');
    const occurrenceCount = await query<{ count: string }>('SELECT count(*) FROM scheduled_payment_occurrences WHERE schedule_id=$1', [created.body.schedule.id]);
    expect(occurrenceCount.rows[0].count).toBe('1');
  });

  it('requires Admin approval for high-value transfers instead of bypassing approval through scheduling', async () => {
    const source = await register('scheduled-high-value');
    const destination = await register('scheduled-high-value-destination');
    const created = await request(app).post('/api/v1/scheduled-payments').set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', `high-value-${crypto.randomUUID()}`).send({ sourceAccountId: source.accountId, destinationAccountId: destination.accountId, amountPaise: '10000001', executeAt: new Date(Date.now() + 60_000).toISOString(), description: 'high value' });
    expect(created.status).toBe(422);
    expect(created.body.error.code).toBe('HIGH_VALUE_SCHEDULE_UNSUPPORTED');
  });

  it('rolls back all writes after an injected failure on the second transfer leg', async () => {
    const source = await register('rollback-source');
    const destination = await register('rollback-destination');
    expect((await amount(source.token, source.accountId, 'deposit', '1000')).status).toBe(201);
    await query('CREATE TABLE test_failure_accounts (account_id UUID PRIMARY KEY)');
    await query(`CREATE FUNCTION fail_test_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_failure_accounts WHERE account_id = NEW.account_id) THEN
          RAISE EXCEPTION 'injected second-leg failure';
        END IF;
        RETURN NEW;
      END; $$`);
    await query('CREATE TRIGGER test_fail_ledger_entry BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_test_ledger_entry()');
    const idempotencyKey = `rollback-${crypto.randomUUID()}`;
    try {
      await query('INSERT INTO test_failure_accounts (account_id) VALUES ($1)', [destination.accountId]);
      const before = await query<{ id: string; balance_paise: string }>('SELECT id, balance_paise FROM accounts WHERE id = ANY($1::uuid[])', [[source.accountId, destination.accountId]]);
      const beforeEntries = await query<{ count: string }>('SELECT count(*) FROM ledger_entries WHERE account_id = ANY($1::uuid[])', [[source.accountId, destination.accountId]]);
      const response = await request(app).post(`/api/v1/accounts/${source.accountId}/transfer`).set('Authorization', `Bearer ${source.token}`).set('Idempotency-Key', idempotencyKey).send({ destinationAccountId: destination.accountId, amountPaise: '250' });
      expect(response.status).toBe(500);
      const after = await query<{ id: string; balance_paise: string }>('SELECT id, balance_paise FROM accounts WHERE id = ANY($1::uuid[])', [[source.accountId, destination.accountId]]);
      const afterEntries = await query<{ count: string }>('SELECT count(*) FROM ledger_entries WHERE account_id = ANY($1::uuid[])', [[source.accountId, destination.accountId]]);
      const partialTransaction = await query<{ count: string }>('SELECT count(*) FROM ledger_transactions WHERE idempotency_key_id IN (SELECT id FROM idempotency_keys WHERE user_id = $1 AND key = $2)', [source.userId, idempotencyKey]);
      expect(after).toEqual(before);
      expect(afterEntries.rows[0].count).toBe(beforeEntries.rows[0].count);
      expect(partialTransaction.rows[0].count).toBe('0');
    } finally {
      await query('DROP TRIGGER IF EXISTS test_fail_ledger_entry ON ledger_entries');
      await query('DROP FUNCTION IF EXISTS fail_test_ledger_entry()');
      await query('DROP TABLE IF EXISTS test_failure_accounts');
    }
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
    await expect(query('DELETE FROM ledger_entries WHERE id = $1', [entry.rows[0].id])).rejects.toThrow();
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
    const originalEntry = await query<{ id: string }>('SELECT id FROM ledger_entries WHERE transaction_id = $1 LIMIT 1', [posted.body.transaction.id]);
    await expect(query('UPDATE ledger_entries SET amount_paise = 99 WHERE id = $1', [originalEntry.rows[0].id])).rejects.toThrow();
    await expect(query('DELETE FROM ledger_entries WHERE id = $1', [originalEntry.rows[0].id])).rejects.toThrow();
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
