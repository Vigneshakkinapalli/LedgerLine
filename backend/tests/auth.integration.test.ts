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
    const response = await request(app).post('/api/v1/auth/register').send({ email, password: 'Holder-password-123!' });
    expect(response.status).toBe(201);
    expect(response.body.user.roles).toEqual(['ACCOUNT_HOLDER']);
    expect(response.body.user.password_hash).toBeUndefined();
    holderToken = response.body.accessToken;
    holderId = response.body.user.id;
    const stored = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [holderId]);
    expect(stored.rows[0].password_hash).not.toBe('Holder-password-123!');
    expect(await argon2.verify(stored.rows[0].password_hash, 'Holder-password-123!')).toBe(true);
  });

  it('rejects invalid credentials without account enumeration', async () => {
    const email = uniqueEmail('login');
    await request(app).post('/api/v1/auth/register').send({ email, password: 'Valid-password-123!' });
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

  it('enforces account ownership and prevents IDOR', async () => {
    const other = await request(app).post('/api/v1/auth/register').send({ email: uniqueEmail('other'), password: 'Other-password-123!' });
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
    const destinations = await request(app).get(`/api/v1/accounts/${ownAccount.rows[0].id}/transfer-destinations`).set('Authorization', `Bearer ${holderToken}`);
    expect(destinations.status).toBe(200);
    expect(destinations.body.accounts.map((account: { id: string }) => account.id)).toContain(otherAccountId);
    expect(destinations.body.accounts.map((account: { id: string }) => account.id)).not.toContain(ownAccount.rows[0].id);
    expect(destinations.body.accounts[0]).toEqual(expect.objectContaining({ displayName: expect.any(String), maskedIdentifier: expect.stringMatching(/^•••• /) }));
    const unauthorizedDestinations = await request(app).get(`/api/v1/accounts/${ownAccount.rows[0].id}/transfer-destinations`).set('Authorization', `Bearer ${otherToken}`);
    expect(unauthorizedDestinations.status).toBe(403);
  });

  it('gives auditors read access but rejects write operations', async () => {
    const auditor = await request(app).post('/api/v1/auth/register').send({ email: uniqueEmail('auditor'), password: 'Auditor-password-123!' });
    auditorId = auditor.body.user.id;
    const roleUpdate = await request(app).put(`/api/v1/admin/users/${auditorId}/roles`).set('Authorization', `Bearer ${adminToken}`).send({ roles: ['AUDITOR'] });
    expect(roleUpdate.status).toBe(200);
    const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [auditorId])).rows[0].email;
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'Auditor-password-123!' });
    auditorToken = login.body.accessToken;
    expect((await request(app).get(`/api/v1/accounts/${otherAccountId}`).set('Authorization', `Bearer ${auditorToken}`)).status).toBe(200);
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
