import argon2 from 'argon2';
import crypto from 'node:crypto';
import type pg from 'pg';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { invalidCredentials, AppError } from '../errors.js';
import { authResponse, hashToken, signAccessToken } from './jwt.js';
import type { AuthenticatedUser, PublicUser, RoleName } from './types.js';

interface UserRow { id: string; email: string; password_hash: string; status: string; created_at: Date; full_name?: string | null; roles?: string[]; }

function rolesOf(values: string[] | undefined): RoleName[] {
  return (values ?? []).filter((value): value is RoleName => ['ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR'].includes(value));
}

function publicUser(user: UserRow, roles: RoleName[]): PublicUser {
  return { id: user.id, email: user.email, fullName: user.full_name ?? null, roles, createdAt: new Date(user.created_at).toISOString() };
}

async function issueSession(client: pg.PoolClient, user: UserRow, roles: RoleName[]) {
  const sessionId = crypto.randomUUID();
  const token = signAccessToken(user.id, sessionId);
  await client.query(
    'INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + ($4 * interval \'1 second\'))',
    [sessionId, user.id, hashToken(token), config.JWT_TTL_SECONDS]
  );
  return { user: { id: user.id, email: user.email, roles, sessionId } satisfies AuthenticatedUser, token };
}

export async function register(email: string, password: string, correlationId?: string, fullName?: string) {
  return withTransaction(async client => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await client.query<UserRow>(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, password_hash, status, created_at, full_name',
      [email, passwordHash, fullName ?? null]
    );
    const user = inserted.rows[0];
    const role = await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'ACCOUNT_HOLDER'");
    await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user.id, role.rows[0].id]);
    const account = await client.query<{ id: string }>(
      "INSERT INTO accounts (owner_user_id, code, kind, currency) VALUES ($1, $2, 'customer', 'INR') RETURNING id",
      [user.id, `ACC_${crypto.randomUUID().replaceAll('-', '')}`]
    );
    await client.query(
      'INSERT INTO account_limits (account_id, daily_debit_limit_paise, daily_credit_limit_paise) VALUES ($1, 100000000, 100000000)',
      [account.rows[0].id]
    );
    await client.query(
      `INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1, 'AUTH_REGISTERED', 'user', $1, $2, $3)`,
      [user.id, JSON.stringify({ role: 'ACCOUNT_HOLDER' }), correlationId ?? null]
    );
    const session = await issueSession(client, user, ['ACCOUNT_HOLDER']);
    return { ...authResponse(session.user, session.token), user: publicUser(user, ['ACCOUNT_HOLDER']) };
  });
}

export async function login(email: string, password: string, correlationId?: string) {
  const result = await query<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.status, u.created_at, u.full_name,
            COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.email = $1 GROUP BY u.id`,
    [email]
  );
  const user = result.rows[0];
  const hash = user?.password_hash ?? await argon2.hash('ledgerline-invalid-password', { type: argon2.argon2id });
  const valid = await argon2.verify(hash, password).catch(() => false);
  if (!user || user.status !== 'active' || !valid) throw invalidCredentials();
  const roles = rolesOf(user.roles);
  return withTransaction(async client => {
    const session = await issueSession(client, user, roles);
    await client.query(
      `INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1, 'AUTH_LOGIN_SUCCEEDED', 'user', $1, '{}'::jsonb, $2)`,
      [user.id, correlationId ?? null]
    );
    return { ...authResponse(session.user, session.token), user: publicUser(user, roles) };
  });
}

export async function recordFailedLogin(email: string, correlationId?: string): Promise<void> {
  const emailHash = crypto.createHash('sha256').update(email).digest('hex');
  await query(
    `INSERT INTO audit_events (event_type, entity_type, metadata, correlation_id)
     VALUES ('AUTH_LOGIN_FAILED', 'authentication', $1, $2)`,
    [JSON.stringify({ emailHash }), correlationId ?? null]
  );
}

export async function logout(user: AuthenticatedUser, correlationId?: string): Promise<void> {
  await withTransaction(async client => {
    await client.query('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2', [user.sessionId, user.id]);
    await client.query(
      `INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1, 'AUTH_LOGOUT', 'user', $1, '{}'::jsonb, $2)`,
      [user.id, correlationId ?? null]
    );
  });
}

export async function listUsers() {
  const result = await query<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.status, u.created_at,
            COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id ORDER BY u.created_at ASC`
  );
  return result.rows.map(user => publicUser(user, rolesOf(user.roles)));
}

export async function setUserRoles(actor: AuthenticatedUser, targetId: string, roles: RoleName[], correlationId?: string) {
  if (actor.id === targetId) throw new AppError(409, 'SELF_ROLE_CHANGE_FORBIDDEN', 'Administrators cannot change their own roles');
  return withTransaction(async client => {
    const target = await client.query<UserRow>('SELECT id, email, password_hash, status, created_at FROM users WHERE id = $1 FOR UPDATE', [targetId]);
    if (!target.rows[0]) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    const currentAdmin = await client.query<{ count: string }>(
      "SELECT count(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'ADMIN'"
    );
    const targetIsAdmin = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.name = 'ADMIN')",
      [targetId]
    );
    if (targetIsAdmin.rows[0].exists && !roles.includes('ADMIN') && Number(currentAdmin.rows[0].count) <= 1) {
      throw new AppError(409, 'LAST_ADMIN_PROTECTED', 'The last administrator cannot be removed');
    }
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [targetId]);
    await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = ANY($2::text[])`,
      [targetId, roles]
    );
    await client.query(
      `INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1, 'AUTH_ROLES_UPDATED', 'user', $2, $3, $4)`,
      [actor.id, targetId, JSON.stringify({ roles }), correlationId ?? null]
    );
    return { ...publicUser(target.rows[0], roles), roles };
  });
}
