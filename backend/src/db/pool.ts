import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) => pool.query<T>(text, values);
