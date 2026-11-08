import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/db/pool.js';

const runDbTests = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!runDbTests)('PostgreSQL schema integration', () => {
  it('connects and has the migration ledger', async () => {
    const result = await query<{ ok: number }>('SELECT 1 AS ok');
    expect(result.rows[0].ok).toBe(1);
    const migrations = await query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
    expect(migrations.rows.map(row => row.filename)).toEqual(expect.arrayContaining(['001_initial_schema.sql', '002_auth_sessions.sql', '003_financial_engine.sql', '004_approval_workflow.sql', '005_module_support.sql', '006_immutable_ledger_entries.sql', '007_attempt_account_scope.sql', '008_reconciliation_history.sql', '009_scheduled_payments.sql', '010_backfill_refused_attempt_accounts.sql', '011_auth_names_and_schedule_references.sql', '012_separate_recurring_payments.sql']));
  });

  it('contains required tables and unique idempotency enforcement', async () => {
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [['users', 'accounts', 'ledger_transactions', 'ledger_entries', 'idempotency_keys', 'transaction_attempts', 'audit_events', 'account_limits', 'auth_sessions']]
    );
    expect(tables.rows).toHaveLength(9);
    const constraints = await query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'idempotency_keys' AND constraint_type = 'UNIQUE'`
    );
    expect(constraints.rows.length).toBeGreaterThan(0);
    const roles = await query<{ name: string }>("SELECT name FROM roles WHERE name = ANY($1::text[])", [['ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR']]);
    expect(roles.rows.map(row => row.name)).toEqual(expect.arrayContaining(['ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR']));
  });

  it('rejects invalid monetary values at the database boundary', async () => {
    await query('BEGIN');
    try {
      const account = await query<{ id: string }>(
        'INSERT INTO accounts (code, kind, currency) VALUES ($1, \'system\', \'INR\') RETURNING id',
        [`DB_TEST_${crypto.randomUUID()}`]
      );
      await expect(query('INSERT INTO account_limits (account_id, daily_debit_limit_paise, daily_credit_limit_paise) VALUES ($1, 0, 1)', [account.rows[0].id])).rejects.toThrow();
    } finally {
      await query('ROLLBACK');
    }
  });
});
