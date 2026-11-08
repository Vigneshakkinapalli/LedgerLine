import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, query } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { AuthenticatedUser } from '../auth/types.js';
import { audit } from './audit.js';

type AnalyticsFilters = {
  startDate?: string;
  endDate?: string;
  accountId?: string;
  transactionType?: 'deposit' | 'withdrawal' | 'transfer' | 'reversal';
  status?: 'posted' | 'reversed' | 'failed' | 'pending';
  granularity: 'day' | 'week' | 'month';
};

const dateString = (date: Date) => date.toISOString().slice(0, 10);

function range(filters: AnalyticsFilters) {
  const end = filters.endDate ? new Date(`${filters.endDate}T00:00:00.000Z`) : new Date();
  const start = filters.startDate ? new Date(`${filters.startDate}T00:00:00.000Z`) : new Date(end.getTime() - 29 * 86_400_000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new AppError(400, 'INVALID_DATE_RANGE', 'Analytics dates are invalid');
  if ((filters.startDate && dateString(start) !== filters.startDate) || (filters.endDate && dateString(end) !== filters.endDate)) throw new AppError(400, 'INVALID_DATE_RANGE', 'Analytics dates are invalid');
  if (end < start) throw new AppError(400, 'INVALID_DATE_RANGE', 'startDate must not be after endDate');
  if ((end.getTime() - start.getTime()) / 86_400_000 > 365) throw new AppError(400, 'DATE_RANGE_TOO_LARGE', 'Analytics date ranges cannot exceed 366 calendar days');
  return { startDate: dateString(start), endDate: dateString(end) };
}

export async function analytics(filters: AnalyticsFilters = { granularity: 'day' }) {
  const { startDate, endDate } = range(filters);
  const params = [startDate, endDate, filters.accountId ?? null, filters.transactionType ?? null, filters.status ?? null];
  const accountClause = `($3::uuid IS NULL OR EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transaction_id = lt.id AND le.account_id = $3) OR lt.source_account_id = $3 OR lt.destination_account_id = $3)`;
  const typeClause = `($4::text IS NULL OR lt.transaction_type = $4)`;
  const statusClause = `($5::text IS NULL OR lt.status::text = $5)`;
  const filtered = `lt.created_at >= $1::date AND lt.created_at < ($2::date + interval '1 day') AND ${accountClause} AND ${typeClause} AND ${statusClause}`;
  const sumAmount = `COALESCE(lt.amount_paise, (SELECT max(abs(le.amount_paise)) FROM ledger_entries le WHERE le.transaction_id = lt.id))`;

  const [kpi, trends, balanceGrowth, distribution, accounts, reconciliation] = await Promise.all([
    query<{
      deposits: string; withdrawals: string; transfers: string; transaction_count: string;
      successful_count: string; failed_count: string; active_accounts: string;
    }>(
      `WITH tx AS (SELECT lt.*, ${sumAmount} AS amount FROM ledger_transactions lt WHERE ${filtered}),
       attempt_totals AS (
         SELECT count(*) FILTER (WHERE ta.status IN ('refused', 'error'))::text AS failed_count
         FROM transaction_attempts ta
         WHERE ta.created_at >= $1::date AND ta.created_at < ($2::date + interval '1 day')
           AND ($3::uuid IS NULL OR ta.account_id = $3)
           AND ($4::text IS NULL OR ta.operation = $4)
           AND ($5::text IS NULL OR $5::text = CASE WHEN ta.status IN ('refused', 'error') THEN 'failed' ELSE ta.status::text END)
       )
       SELECT COALESCE(sum(amount) FILTER (WHERE transaction_type = 'deposit' AND status IN ('posted','reversed')),0)::text AS deposits,
              COALESCE(sum(amount) FILTER (WHERE transaction_type = 'withdrawal' AND status IN ('posted','reversed')),0)::text AS withdrawals,
              COALESCE(sum(amount) FILTER (WHERE transaction_type = 'transfer' AND status IN ('posted','reversed')),0)::text AS transfers,
              count(*)::text AS transaction_count,
              count(*) FILTER (WHERE status IN ('posted','reversed'))::text AS successful_count,
              ((SELECT count(*) FROM tx WHERE status = 'failed') + (SELECT failed_count::bigint FROM attempt_totals))::text AS failed_count,
              (SELECT count(*) FROM accounts a WHERE a.kind = 'customer' AND a.status = 'active' AND ($3::uuid IS NULL OR a.id = $3))::text AS active_accounts
       FROM tx`, params
    ),
    query<{ period: string; deposits: string; withdrawals: string; transfers: string; transaction_count: string }>(
      `SELECT date_trunc($6, lt.created_at)::date::text AS period,
              COALESCE(sum(${sumAmount}) FILTER (WHERE lt.transaction_type = 'deposit' AND lt.status IN ('posted','reversed')),0)::text AS deposits,
              COALESCE(sum(${sumAmount}) FILTER (WHERE lt.transaction_type = 'withdrawal' AND lt.status IN ('posted','reversed')),0)::text AS withdrawals,
              COALESCE(sum(${sumAmount}) FILTER (WHERE lt.transaction_type = 'transfer' AND lt.status IN ('posted','reversed')),0)::text AS transfers,
              count(*)::text AS transaction_count
       FROM ledger_transactions lt WHERE ${filtered} GROUP BY 1 ORDER BY 1`, [...params, filters.granularity]
    ),
    query<{ period: string; balance: string }>(
      `WITH buckets AS (
         SELECT date_trunc($4, value)::date AS period
         FROM generate_series(date_trunc($4, $1::date::timestamp), date_trunc($4, $2::date::timestamp),
           CASE $4 WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week' ELSE interval '1 month' END) value
       ), deltas AS (
         SELECT date_trunc($4, le.created_at)::date AS period, sum(le.amount_paise)::numeric AS delta
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
         JOIN ledger_transactions lt ON lt.id = le.transaction_id
         WHERE a.kind = 'customer' AND lt.status IN ('posted','reversed')
           AND le.created_at < ($2::date + interval '1 day') AND ($3::uuid IS NULL OR le.account_id = $3)
         GROUP BY 1
       )
       SELECT buckets.period::text, COALESCE(sum(deltas.delta) OVER (ORDER BY buckets.period),0)::text AS balance
       FROM buckets LEFT JOIN deltas USING (period) ORDER BY buckets.period`, [startDate, endDate, filters.accountId ?? null, filters.granularity]
    ),
    query<{ transaction_type: string; status: string; count: string; amount: string }>(
      `SELECT lt.transaction_type, lt.status::text AS status, count(*)::text AS count,
              COALESCE(sum(${sumAmount}),0)::text AS amount
       FROM ledger_transactions lt WHERE ${filtered}
       GROUP BY lt.transaction_type, lt.status ORDER BY lt.transaction_type, lt.status`, params
    ),
    query<{ id: string; display_name: string; currency: string; balance_paise: string; status: string; transaction_count: string; volume_paise: string }>(
      `SELECT a.id, COALESCE(split_part(u.email, '@', 1), 'LedgerLine recipient') AS display_name,
              a.currency, a.balance_paise::text, a.status,
              count(DISTINCT lt.id)::text AS transaction_count,
              COALESCE(sum(${sumAmount}),0)::text AS volume_paise
       FROM accounts a LEFT JOIN users u ON u.id = a.owner_user_id
       LEFT JOIN ledger_entries le ON le.account_id = a.id
       LEFT JOIN ledger_transactions lt ON lt.id = le.transaction_id
         AND lt.created_at >= $1::date AND lt.created_at < ($2::date + interval '1 day')
         AND ($4::text IS NULL OR lt.transaction_type = $4) AND ($5::text IS NULL OR lt.status::text = $5)
       WHERE a.kind = 'customer' AND ($3::uuid IS NULL OR a.id = $3)
       GROUP BY a.id, u.email ORDER BY a.created_at DESC LIMIT 100`, params
    ),
    query<{ id: string; completed_at: Date; discrepancy_count: number; status: string }>(
      `SELECT id, completed_at, discrepancy_count, status FROM reconciliation_runs ORDER BY completed_at DESC LIMIT 1`
    ).catch(error => {
      if ((error as { code?: string }).code === '42P01') return { rows: [] as { id: string; completed_at: Date; discrepancy_count: number; status: string }[], rowCount: 0 };
      throw error;
    })
  ]);

  return {
    filters: { startDate, endDate, accountId: filters.accountId ?? null, transactionType: filters.transactionType ?? null, status: filters.status ?? null, granularity: filters.granularity },
    kpis: Object.fromEntries(Object.entries(kpi.rows[0]).map(([key, value]) => [key, value])),
    trends: trends.rows,
    balanceGrowth: balanceGrowth.rows,
    distribution: distribution.rows,
    accounts: accounts.rows,
    reconciliation: reconciliation.rows[0] ?? null
  };
}

async function collectReconciliationFindings(client: PoolClient) {
  const accounts = await client.query<{ account_id: string; code: string; snapshot: string; ledger: string }>(
    `SELECT a.id::text AS account_id, a.code, a.balance_paise::text AS snapshot,
            COALESCE(sum(le.amount_paise),0)::text AS ledger
     FROM accounts a LEFT JOIN ledger_entries le ON le.account_id = a.id
     WHERE a.kind = 'customer' GROUP BY a.id ORDER BY a.code`
  );
  const findings: Array<{ type: string; severity: string; accountId: string | null; transactionId: string | null; details: Record<string, unknown> }> = [];
  for (const account of accounts.rows) {
    if (account.snapshot !== account.ledger) findings.push({ type: 'BALANCE_MISMATCH', severity: 'critical', accountId: account.account_id, transactionId: null, details: { accountCode: account.code, snapshotBalancePaise: account.snapshot, ledgerBalancePaise: account.ledger, discrepancyPaise: (BigInt(account.snapshot) - BigInt(account.ledger)).toString() } });
  }
  const anomalies = await client.query<{ transaction_id: string; reference: string; status: string; entry_count: string; total: string; kind: string }>(
    `SELECT lt.id::text AS transaction_id, lt.reference, lt.status::text AS status,
            count(le.id)::text AS entry_count, COALESCE(sum(le.amount_paise),0)::text AS total,
            CASE WHEN count(le.id) = 0 THEN 'MISSING_POSTING' ELSE 'UNBALANCED_POSTING' END AS kind
     FROM ledger_transactions lt LEFT JOIN ledger_entries le ON le.transaction_id = lt.id
     WHERE lt.status IN ('posted','reversed') GROUP BY lt.id
     HAVING count(le.id) = 0 OR COALESCE(sum(le.amount_paise),0) <> 0
     ORDER BY lt.created_at DESC`
  );
  for (const anomaly of anomalies.rows) findings.push({ type: anomaly.kind, severity: 'critical', accountId: null, transactionId: anomaly.transaction_id, details: { reference: anomaly.reference, status: anomaly.status, entryCount: anomaly.entry_count, totalPaise: anomaly.total } });
  const duplicateKeys = await client.query<{ idempotency_key_id: string; count: string; transaction_ids: string[] }>(
    `SELECT idempotency_key_id::text, count(*)::text, array_agg(id::text ORDER BY created_at) AS transaction_ids
     FROM ledger_transactions WHERE idempotency_key_id IS NOT NULL GROUP BY idempotency_key_id HAVING count(*) > 1`
  );
  for (const duplicate of duplicateKeys.rows) findings.push({ type: 'DUPLICATE_IDEMPOTENCY_POSTING', severity: 'critical', accountId: null, transactionId: null, details: { idempotencyKeyId: duplicate.idempotency_key_id, count: duplicate.count, transactionIds: duplicate.transaction_ids } });
  return findings;
}

export async function runReconciliation(actor: AuthenticatedUser, correlationId?: string) {
  const client = await pool.connect();
  const runId = crypto.randomUUID();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query('INSERT INTO reconciliation_runs (id, initiated_by, status) VALUES ($1, $2, \'running\')', [runId, actor.id]);
    const findings = await collectReconciliationFindings(client);
    for (const finding of findings) {
      await client.query(
        `INSERT INTO reconciliation_findings (run_id, finding_type, severity, account_id, transaction_id, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, finding.type, finding.severity, finding.accountId, finding.transactionId, JSON.stringify(finding.details)]
      );
    }
    await client.query("UPDATE reconciliation_runs SET status = 'completed', completed_at = now(), discrepancy_count = $2 WHERE id = $1", [runId, findings.length]);
    await audit(client, actor.id, 'RECONCILIATION_COMPLETED', 'reconciliation_run', runId, { findings: findings.length }, correlationId);
    await client.query('COMMIT');
    return { id: runId, status: 'completed', completedAt: new Date().toISOString(), discrepancyCount: findings.length, findings };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function reconciliationSchedule() {
  const result = await query('SELECT schedule_key, enabled, cadence, next_run_at, updated_by, updated_at FROM reconciliation_schedules WHERE schedule_key = 1');
  return result.rows[0] ?? null;
}

export async function updateReconciliationSchedule(input: { enabled: boolean; cadence: 'daily' | 'weekly' }, actor: AuthenticatedUser, correlationId?: string) {
  return withPoolTransaction(async client => {
    const result = await client.query(
      `UPDATE reconciliation_schedules
       SET enabled = $1, cadence = $2,
           next_run_at = CASE WHEN $1 THEN now() + CASE $2 WHEN 'daily' THEN interval '1 day' ELSE interval '1 week' END ELSE NULL END,
           updated_by = $3, updated_at = now()
       WHERE schedule_key = 1
       RETURNING schedule_key, enabled, cadence, next_run_at, updated_by, updated_at`,
      [input.enabled, input.cadence, actor.id]
    );
    await audit(client, actor.id, 'RECONCILIATION_SCHEDULE_UPDATED', 'reconciliation_schedule', null, { enabled: input.enabled, cadence: input.cadence }, correlationId);
    return result.rows[0];
  });
}

export async function pollScheduledReconciliation(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schedule = await client.query<{ cadence: 'daily' | 'weekly'; updated_by: string }>(
      'SELECT cadence, updated_by FROM reconciliation_schedules WHERE schedule_key = 1 AND enabled = true AND next_run_at <= now() FOR UPDATE SKIP LOCKED'
    );
    if (!schedule.rows[0]?.updated_by) { await client.query('COMMIT'); return false; }
    const runId = crypto.randomUUID();
    const actorId = schedule.rows[0].updated_by;
    await client.query('INSERT INTO reconciliation_runs (id, initiated_by, status) VALUES ($1, $2, \'running\')', [runId, actorId]);
    const findings = await collectReconciliationFindings(client);
    for (const finding of findings) {
      await client.query('INSERT INTO reconciliation_findings (run_id, finding_type, severity, account_id, transaction_id, details) VALUES ($1, $2, $3, $4, $5, $6)', [runId, finding.type, finding.severity, finding.accountId, finding.transactionId, JSON.stringify(finding.details)]);
    }
    await client.query("UPDATE reconciliation_runs SET status = 'completed', completed_at = now(), discrepancy_count = $2 WHERE id = $1", [runId, findings.length]);
    await client.query(
      `UPDATE reconciliation_schedules SET next_run_at = now() + CASE cadence WHEN 'daily' THEN interval '1 day' ELSE interval '1 week' END, updated_at = now() WHERE schedule_key = 1`
    );
    await audit(client, actorId, 'SCHEDULED_RECONCILIATION_COMPLETED', 'reconciliation_run', runId, { findings: findings.length }, undefined);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function reconciliationHistory(page: number, pageSize: number) {
  const result = await query<{ id: string; status: string; initiated_by: string; started_at: Date; completed_at: Date | null; discrepancy_count: number; total: string }>(
    `SELECT r.id, r.status, r.initiated_by, r.started_at, r.completed_at, r.discrepancy_count,
            count(*) OVER()::text AS total
     FROM reconciliation_runs r ORDER BY r.started_at DESC LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize]
  );
  return { runs: result.rows.map(({ total, ...run }) => run), pagination: { page, pageSize, totalRecords: Number(result.rows[0]?.total ?? 0), totalPages: Math.ceil(Number(result.rows[0]?.total ?? 0) / pageSize) } };
}

export async function reconciliationFindingsForRun(runId: string) {
  const result = await query('SELECT * FROM reconciliation_findings WHERE run_id = $1 ORDER BY severity DESC, created_at, id', [runId]);
  if (!result.rows.length) {
    const run = await query('SELECT id FROM reconciliation_runs WHERE id = $1', [runId]);
    if (!run.rows.length) throw new AppError(404, 'RECONCILIATION_RUN_NOT_FOUND', 'Reconciliation run not found');
  }
  return result.rows;
}

export async function reconciliationFindingDetail(findingId: string) {
  const result = await query('SELECT * FROM reconciliation_findings WHERE id = $1', [findingId]);
  if (!result.rows[0]) throw new AppError(404, 'RECONCILIATION_FINDING_NOT_FOUND', 'Reconciliation finding not found');
  return result.rows[0];
}

export async function updateReconciliationFinding(findingId: string, input: { status: 'investigating' | 'resolved'; resolutionNote: string }, actor: AuthenticatedUser, correlationId?: string) {
  return withPoolTransaction(async client => {
    const current = await client.query<{ id: string; status: string; investigated_by: string | null }>('SELECT id, status, investigated_by FROM reconciliation_findings WHERE id = $1 FOR UPDATE', [findingId]);
    if (!current.rows[0]) throw new AppError(404, 'RECONCILIATION_FINDING_NOT_FOUND', 'Reconciliation finding not found');
    if (current.rows[0].status === 'resolved') throw new AppError(409, 'FINDING_ALREADY_RESOLVED', 'Resolved reconciliation findings are immutable');
    if (input.status === 'resolved' && current.rows[0].status !== 'investigating') throw new AppError(409, 'INVESTIGATION_REQUIRED', 'A finding must be investigated before it can be resolved');
    if (input.status === 'resolved' && current.rows[0].investigated_by === actor.id) throw new AppError(409, 'MAKER_CHECKER_REQUIRED', 'A different administrator must resolve a finding after investigation');
    const result = await client.query(
      `UPDATE reconciliation_findings
       SET status = $2, resolution_note = $3,
           investigated_by = CASE WHEN $2 = 'investigating' THEN $4 ELSE investigated_by END,
           resolved_by = CASE WHEN $2 = 'resolved' THEN $4 ELSE resolved_by END,
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [findingId, input.status, input.resolutionNote, actor.id]
    );
    await audit(client, actor.id, 'RECONCILIATION_FINDING_UPDATED', 'reconciliation_finding', findingId, { status: input.status, note: input.resolutionNote }, correlationId);
    return result.rows[0];
  });
}

async function withPoolTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
