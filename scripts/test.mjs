import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const require = createRequire(path.join(backend, 'package.json'));
require('dotenv').config({ path: path.join(root, '.env') });
const { Client } = require('pg');
const runDbTests = process.env.RUN_DB_TESTS === '1';

function runVitest(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'test:vitest', '--workspace', 'backend'], {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Vitest stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

if (!runDbTests) {
  process.exitCode = await runVitest(process.env);
} else {
  const sourceUrl = new URL(process.env.DATABASE_URL ?? 'postgres://ledgerline:ledgerline@localhost:5433/ledgerline');
  if (!['localhost', '127.0.0.1', '::1'].includes(sourceUrl.hostname)) {
    throw new Error('Database integration tests only run against a local PostgreSQL host. Refusing to touch a remote database.');
  }
  const testDatabase = `ledgerline_test_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = '/postgres';
  const databaseUrl = new URL(sourceUrl);
  databaseUrl.pathname = `/${testDatabase}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let created = false;

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${testDatabase}"`);
    created = true;

    const testClient = new Client({ connectionString: databaseUrl.toString() });
    await testClient.connect();
    try {
      await testClient.query('CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const migrationsDir = path.join(root, 'database', 'migrations');
      const files = (await readdir(migrationsDir)).filter(file => file.endsWith('.sql')).sort();
      for (const filename of files) {
        await testClient.query('BEGIN');
        try {
          await testClient.query(await readFile(path.join(migrationsDir, filename), 'utf8'));
          await testClient.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
          await testClient.query('COMMIT');
        } catch (error) {
          await testClient.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await testClient.end();
    }

    const result = await runVitest({ ...process.env, RUN_DB_TESTS: '1', DATABASE_URL: databaseUrl.toString() });
    process.exitCode = result;
  } finally {
    if (created) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [testDatabase]);
      await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}"`);
    }
    await admin.end();
  }
}
