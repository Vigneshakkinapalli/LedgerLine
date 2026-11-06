import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from './pool.js';

const candidates = [
  path.resolve(process.cwd(), 'database/migrations'),
  path.resolve(process.cwd(), '../database/migrations')
];
let root = candidates[0];
for (const candidate of candidates) {
  try {
    await access(candidate);
    root = candidate;
    break;
  } catch {
    // Try the next supported working-directory layout.
  }
}

const client = await pool.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
  const done = new Set(applied.rows.map(row => row.filename));
  const files = (await readdir(root)).filter(file => file.endsWith('.sql')).sort();
  for (const filename of files) {
    if (done.has(filename)) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(path.join(root, filename), 'utf8'));
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      console.log(`Applied ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally { client.release(); await pool.end(); }
