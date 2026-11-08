import argon2 from 'argon2';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { query } from '../src/db/pool.js';
import { resetLoginRateLimitForTests } from '../src/auth/rate-limit.js';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const uniqueEmail = (prefix: string) => `${prefix}-${crypto.randomUUID()}@example.test`;

describe.skipIf(!runDbTests).sequential('authentication and RBAC integration', () => {
  let holderToken = '';
  let holderId = '';
  let otherToken = '';
  let otherAccountId = '';
  let adminToken = '';
  let auditorToken = '';
  let auditorId = '';

  beforeAll(async () => {
    resetLoginRateLimitForTests();
    const passwordHash = await argon2.hash('Admin-password-123!', { type: argon2.argon2id });
    const admin = await query<{ id: string; email: string; created_at: Date }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [uniqueEmail('admin'), passwordHash]
    );
    const role = await query<{ id: string }>("SELECT id FROM roles WHERE name = 'ADMIN'");
    await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [admin.rows[0].id, role.rows[0].id]);
    const login = await request(app).post('/api/v1/auth/login').send({ email: admin.rows[0].email, password: 'Admin-password-123!' });
    adminToken = login.body.accessToken;
  });

  it('registers a holder, hashes the password, and returns a safe user', async () => {
    const email = uniqueEmail('holder');
    const response = await request(app).post('/api/v1/auth/register').send({ fullName: 'Test Holder', email, password: 'Holder-password-123!' });
    expect(response.status).toBe(201);
    expect(response.body.user.roles).toEqual(['ACCOUNT_HOLDER']);
    expect(response.body.user.fullName).toBe('Test Holder');
    expect(response.body.user.password_hash).toBeUndefined();
    expect(response.body.user.roles).toEqual(['ACCOUNT_HOLDER']);
    holderToken = response.body.accessToken;
    holderId = response.body.user.id;
    const stored = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [holderId]);
    expect(stored.rows[0].password_hash).not.toBe('Holder-password-123!');
    expect(await argon2.verify(stored.rows[0].password_hash, 'Holder-password-123!')).toBe(true);
    const storedName = await query<{ full_name: string }>('SELECT full_name FROM users WHERE id=$1', [holderId]);
    expect(storedName.rows[0].full_name).toBe('Test Holder');
    const duplicate = await request(app).post('/api/v1/auth/register').send({ fullName: 'Test Holder', email, password: 'Holder-password-123!' });
    expect(duplicate.status).toBe(409);
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'Holder-password-123!' });
    expect(login.status).toBe(200);
    expect(login.body.user).toEqual(expect.objectContaining({ id: holderId, fullName: 'Test Holder', roles: ['ACCOUNT_HOLDER'] }));
  });

  it('rejects invalid credentials without account enumeration', async () => {
    const email = uniqueEmail('login');
    await request(app).post('/api/v1/auth/register').send({ fullName: 'Login Test', email, password: 'Valid-password-123!' });
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: uniqueEmail('missing'), password: 'Wrong-password-123!' });
    const wrong = await request(app).post('/api/v1/auth/login').send({ email, password: 'Wrong-password-123!' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('accepts current-user access, rejects invalid/expired JWTs, and revokes logout', async () => {
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${holderToken}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer invalid-token')).status).toBe(401);
    const expired = jwt.sign({ sub: holderId, sid: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) - 1 }, config.JWT_SECRET);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${holderToken}`)).status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${holderToken}`)).status).toBe(401);
    const relogin = await request(app).post('/api/v1/auth/login').send({ email: (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [holderId])).rows[0].email, password: 'Holder-password-123!' });
    holderToken = relogin.body.accessToken;
  });

  it('enforces admin authorization and prevents holder role escalation', async () => {
    const forbidden = await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${holderToken}`);
    expect(forbidden.status).toBe(403);
    const escalation = await request(app).put(`/api/v1/admin/users/${holderId}/roles`).set('Authorization', `Bearer ${holderToken}`).send({ roles: ['ADMIN'] });
    expect(escalation.status).toBe(403);
    const adminUsers = await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${adminToken}`);
    expect(adminUsers.status).toBe(200);
    expect(adminUsers.body.users.some((user: { id: string }) => user.id === holderId)).toBe(true);
  });

  it('creates an account for an account-less user and returns its persisted balance', async () => {
    const user = await query<{ id: string }>('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [uniqueEmail('account-create'), await argon2.hash('Account-create-123!', { type: argon2.argon2id })]);
    const created = await request(app).post('/api/v1/accounts').set('Authorization', `Bearer ${adminToken}`).send({ userId: user.rows[0].id, currency: 'INR' });
    expect(created.status).toBe(201);
    const accountId = created.body.account.id as string;
    const account = await request(app).get(`/api/v1/accounts/${accountId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(account.status).toBe(200);
    expect(account.body.account).toEqual(expect.objectContaining({ id: accountId, balancePaise: '0', currency: 'INR' }));
  });

  it('allows an account-less account holder to create their INR account and retrieve its balance', async () => {
    const email = uniqueEmail('holder-account-create');
    const password = 'Holder-create-123!';
    const inserted = await query<{ id: string }>('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await argon2.hash(password, { type: argon2.argon2id })]);
    await query("INSERT INTO user_roles (user_id, role_id) SELECT $1,id FROM roles WHERE name='ACCOUNT_HOLDER'", [inserted.rows[0].id]);
    const login = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    const created = await request(app).post('/api/v1/accounts').set('Authorization', `Bearer ${login.body.accessToken}`).send({ userId: inserted.rows[0].id, currency: 'INR' });
    expect(created.status).toBe(201);
    const accountId = created.body.account.id as string;
    const read = await request(app).get(`/api/v1/accounts/${accountId}`).set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(read.status).toBe(200);
    expect(read.body.account).toEqual(expect.objectContaining({ id: accountId, balancePaise: '0', currency: 'INR', ownerUserId: inserted.rows[0].id }));
  });

  it('enforces account ownership and prevents IDOR', async () => {
    const other = await request(app).post('/api/v1/auth/register').send({ fullName: 'Other User', email: uniqueEmail('other'), password: 'Other-password-123!' });
    otherToken = other.body.accessToken;
    const otherAccount = await query<{ id: string }>('SELECT id FROM accounts WHERE owner_user_id = $1', [other.body.user.id]);
    otherAccountId = otherAccount.rows[0].id;
    const ownAccount = await query<{ id: string }>('SELECT id FROM accounts WHERE owner_user_id = $1', [holderId]);
    const listed = await request(app).get('/api/v1/accounts').set('Authorization', `Bearer ${holderToken}`);
    expect(listed.status).toBe(200);
    expect(listed.body.accounts.map((account: { id: string }) => account.id)).toContain(ownAccount.rows[0].id);
    expect(listed.body.accounts.map((account: { id: string }) => account.id)).not.toContain(otherAccountId);
    expect((await request(app).get(`/api/v1/accounts/${ownAccount.rows[0].id}`).set('Authorization', `Bearer ${holderToken}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/accounts/${otherAccountId}`).set('Authorization', `Bearer ${holderToken}`)).status).toBe(403);
    expect((await request(app).get(`/api/v1/accounts/${otherAccountId}`).set('Authorization', `Bearer ${otherToken}`)).status).toBe(200);
    expect((await request(app).post(`/api/v1/accounts/${otherAccountId}/permissions`).set('Authorization', `Bearer ${adminToken}`).send({ userId: holderId, permission: 'transfer' })).status).toBe(204);
    expect((await request(app).post(`/api/v1/accounts/${otherAccountId}/permissions`).set('Authorization', `Bearer ${adminToken}`).send({ userId: holderId, permission: 'view' })).status).toBe(204);
    expect((await request(app).get(`/api/v1/accounts/${otherAccountId}`).set('Authorization', `Bearer ${holderToken}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/accounts/${otherAccountId}/transactions`).set('Authorization', `Bearer ${holderToken}`)).status).toBe(200);
    const destinations = await request(app).get(`/api/v1/accounts/${ownAccount.rows[0].id}/transfer-destinations`).set('Authorization', `Bearer ${holderToken}`);
    expect(destinations.status).toBe(200);
    expect(destinations.body.accounts.map((account: { id: string }) => account.id)).toContain(otherAccountId);
    expect(destinations.body.accounts.map((account: { id: string }) => account.id)).not.toContain(ownAccount.rows[0].id);
    expect(destinations.body.accounts[0]).toEqual(expect.objectContaining({ displayName: expect.any(String), maskedIdentifier: expect.stringMatching(/^•••• /) }));
    expect(destinations.body.accounts[0]).not.toHaveProperty('ownerUserId');
    expect(destinations.body.accounts[0]).not.toHaveProperty('balancePaise');
    expect(destinations.body.accounts[0].displayName).not.toContain('@');
    const unauthorizedDestinations = await request(app).get(`/api/v1/accounts/${ownAccount.rows[0].id}/transfer-destinations`).set('Authorization', `Bearer ${otherToken}`);
    expect(unauthorizedDestinations.status).toBe(403);
    const viewOnly = await request(app).post('/api/v1/auth/register').send({ fullName: 'View Only', email: uniqueEmail('view-only-source'), password: 'View-only-password-123!' });
    const viewOnlyAccount = await query<{ id: string }>('SELECT id FROM accounts WHERE owner_user_id=$1', [viewOnly.body.user.id]);
    expect((await request(app).post(`/api/v1/accounts/${viewOnlyAccount.rows[0].id}/permissions`).set('Authorization', `Bearer ${adminToken}`).send({ userId: holderId, permission: 'view' })).status).toBe(204);
    const scheduleSources = await request(app).get('/api/v1/scheduled-payments/eligible-accounts').set('Authorization', `Bearer ${holderToken}`);
    expect(scheduleSources.status).toBe(200);
    expect(scheduleSources.body.accounts.map((account: { id: string }) => account.id)).toContain(ownAccount.rows[0].id);
    expect(scheduleSources.body.accounts.map((account: { id: string }) => account.id)).toContain(otherAccountId);
    expect(scheduleSources.body.accounts.map((account: { id: string }) => account.id)).not.toContain(viewOnlyAccount.rows[0].id);
    const scheduledDestinations = await request(app).get(`/api/v1/accounts/${ownAccount.rows[0].id}/transfer-destinations`).set('Authorization', `Bearer ${holderToken}`);
    expect(scheduledDestinations.body.accounts.map((account: { id: string }) => account.id)).toContain(otherAccountId);
    expect(scheduledDestinations.body.accounts.map((account: { id: string }) => account.id)).not.toContain(ownAccount.rows[0].id);
    expect((await request(app).get('/api/v1/analytics').set('Authorization', `Bearer ${holderToken}`)).status).toBe(403);
    const otherEvent = await query<{ id: string }>("SELECT id FROM audit_events WHERE actor_user_id = $1 AND event_type = 'AUTH_REGISTERED' LIMIT 1", [other.body.user.id]);
    expect((await request(app).post(`/api/v1/notifications/${otherEvent.rows[0].id}/read`).set('Authorization', `Bearer ${holderToken}`)).status).toBe(404);
    const ownEvent = await query<{ id: string }>("SELECT id FROM audit_events WHERE actor_user_id = $1 AND event_type = 'AUTH_REGISTERED' LIMIT 1", [holderId]);
    expect((await request(app).post(`/api/v1/notifications/${ownEvent.rows[0].id}/read`).set('Authorization', `Bearer ${holderToken}`)).status).toBe(204);
    expect((await request(app).post(`/api/v1/notifications/${ownEvent.rows[0].id}/read`).set('Authorization', `Bearer ${holderToken}`)).status).toBe(204);
  });

  it('gives auditors read access but rejects write operations', async () => {
    const auditor = await request(app).post('/api/v1/auth/register').send({ fullName: 'Audit User', email: uniqueEmail('auditor'), password: 'Auditor-password-123!' });
    auditorId = auditor.body.user.id;
    const roleUpdate = await request(app).put(`/api/v1/admin/users/${auditorId}/roles`).set('Authorization', `Bearer ${adminToken}`).send({ roles: ['AUDITOR'] });
    expect(roleUpdate.status).toBe(200);
    const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [auditorId])).rows[0].email;
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'Auditor-password-123!' });
    auditorToken = login.body.accessToken;
    expect((await request(app).get(`/api/v1/accounts/${otherAccountId}`).set('Authorization', `Bearer ${auditorToken}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/analytics').set('Authorization', `Bearer ${auditorToken}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/analytics').set('Authorization', `Bearer ${adminToken}`)).status).toBe(200);
    expect((await request(app).post('/api/v1/accounts').set('Authorization', `Bearer ${auditorToken}`).send({ userId: auditorId, currency: 'INR' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/accounts/${otherAccountId}/deposit`).set('Authorization', `Bearer ${auditorToken}`).set('Idempotency-Key', crypto.randomUUID()).send({ amountPaise: '1' })).status).toBe(422);
    for (const permission of ['deposit', 'withdraw', 'transfer']) {
      expect((await request(app).post(`/api/v1/accounts/${otherAccountId}/permissions`).set('Authorization', `Bearer ${adminToken}`).send({ userId: auditorId, permission })).status).toBe(204);
    }
    const ledgerBefore = await query<{ count: string }>('SELECT count(*) FROM ledger_entries WHERE account_id=$1', [otherAccountId]);
    const auditorAccount = await query<{ id: string }>('SELECT id FROM accounts WHERE owner_user_id=$1', [auditorId]);
    const auditorWrites = await Promise.all([
      request(app).post(`/api/v1/accounts/${otherAccountId}/deposit`).set('Authorization', `Bearer ${auditorToken}`).set('Idempotency-Key', crypto.randomUUID()).send({ amountPaise: '1' }),
      request(app).post(`/api/v1/accounts/${otherAccountId}/withdraw`).set('Authorization', `Bearer ${auditorToken}`).set('Idempotency-Key', crypto.randomUUID()).send({ amountPaise: '1' }),
      request(app).post(`/api/v1/accounts/${otherAccountId}/transfer`).set('Authorization', `Bearer ${auditorToken}`).set('Idempotency-Key', crypto.randomUUID()).send({ destinationAccountId: auditorAccount.rows[0].id, amountPaise: '1' })
    ]);
    expect(auditorWrites.map(response => [response.status, response.body.error.code])).toEqual([[422, 'FORBIDDEN'], [422, 'FORBIDDEN'], [422, 'FORBIDDEN']]);
    const ledgerAfter = await query<{ count: string }>('SELECT count(*) FROM ledger_entries WHERE account_id=$1', [otherAccountId]);
    expect(ledgerAfter.rows[0].count).toBe(ledgerBefore.rows[0].count);
    expect((await request(app).put(`/api/v1/admin/users/${auditorId}/roles`).set('Authorization', `Bearer ${auditorToken}`).send({ roles: ['ADMIN'] })).status).toBe(403);
  });

  it('rate-limits repeated login failures', async () => {
    resetLoginRateLimitForTests();
    const email = uniqueEmail('rate-limit');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await request(app).post('/api/v1/auth/login').send({ email, password: 'Wrong-password-123!' })).status).toBe(401);
    }
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: 'Wrong-password-123!' })).status).toBe(429);
  });

  it('exposes protected audit and admin reporting without allowing holder access', async () => {
    expect((await request(app).get('/api/v1/admin/audit/verify').set('Authorization', `Bearer ${holderToken}`)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/summary').set('Authorization', `Bearer ${adminToken}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/audit/verify').set('Authorization', `Bearer ${adminToken}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${holderToken}`)).status).toBe(200);
  });
});
