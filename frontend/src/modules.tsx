import { useEffect, useMemo, useState } from 'react';
import { rupeesToPaise } from './money';

type User = { id: string; email: string; roles: string[] };
type Account = { id: string; displayName: string; maskedIdentifier: string; status: string; currency: string; balancePaise: string };
type Entry = { transaction_id: string; reference: string; transaction_type: string; status: string; amountPaise: string; runningBalancePaise?: string; initiator?: string | null; counterparty?: string | null; createdAt: string };
type StatementItem = { type: 'entry' | 'refused_attempt'; id: string; transactionId?: string | null; reference?: string | null; operation: string; status: string; amountPaise: string | null; createdAt: string; initiator: string | null; counterparty?: string | null; reason?: string | null; runningBalancePaise: string };
type Statement = { items: StatementItem[]; entries: Entry[]; refusedAttempts: Array<{ id: string; reason: string | null; amountPaise: string | null; operation: string; initiator: string | null; createdAt: string; runningBalancePaise: string }>; pagination: { page: number; pageSize: number; totalRecords: number; totalPages: number } };
const api = async <T,>(base: string, path: string, token: string, options: RequestInit = {}) => { const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers ?? {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error?.message ?? 'Request failed'); return body as T; };
const money = (paise: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(paise) / 100);

function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <section className="panel module-panel"><div className="eyebrow">LEDGERLINE / {title.toUpperCase()}</div><h2>{title}</h2>{children}</section>; }
function AccountsPage({ base, token, user }: { base: string; token: string; user: User }) { const [accounts, setAccounts] = useState<Account[]>([]); const [error, setError] = useState(''); const [created, setCreated] = useState(''); useEffect(() => { api<{ accounts: Account[] }>(base, '/accounts', token).then(r => setAccounts(r.accounts)).catch(e => setError(e.message)); }, [base, token]); async function create() { try { const r = await api<{ account: { code: string } }>(base, '/accounts', token, { method: 'POST', body: JSON.stringify({ userId: user.id, currency: 'INR' }) }); setCreated(`Created ${r.account.code}`); const next = await api<{ accounts: Account[] }>(base, '/accounts', token); setAccounts(next.accounts); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to create account'); } } return <Panel title="Accounts"><button onClick={create}>Create INR account</button>{created && <div className="success">{created}</div>}{error && <div className="error">{error}</div>}<div className="account-management-grid">{accounts.map(a => <article className="account-detail" key={a.id}><h2>{a.displayName}</h2><p className="card-label">{a.maskedIdentifier}</p><strong>{money(a.balancePaise)}</strong><span className={`account-status ${a.status}`}>{a.status}</span><small>{a.currency} customer account</small></article>)}</div></Panel>; }
function StatementsPage({ base, token }: { base: string; token: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState('');
  const [statement, setStatement] = useState<Statement | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ accounts: Account[] }>(base, '/accounts', token)
      .then(result => { setAccounts(result.accounts); if (result.accounts[0]) setSelected(result.accounts[0].id); })
      .catch(e => setError(e.message));
  }, [base, token]);

  useEffect(() => {
    if (!selected) return;
    setStatement(null);
    api<Statement>(base, `/accounts/${selected}/transactions?page=${page}&pageSize=50`, token)
      .then(setStatement)
      .catch(e => setError(e.message));
  }, [base, token, selected, page]);

  const items = useMemo(() => statement?.items.filter(item => `${item.reference ?? ''} ${item.operation} ${item.initiator ?? ''} ${item.reason ?? ''}`.toLowerCase().includes(search.toLowerCase())) ?? [], [statement, search]);

  async function exportCsv() {
    if (!selected || !statement) return;
    const allItems: StatementItem[] = [];
    for (let currentPage = 1; currentPage <= Math.ceil(statement.pagination.totalRecords / 100); currentPage += 1) {
      const result = await api<Statement>(base, `/accounts/${selected}/transactions?page=${currentPage}&pageSize=100`, token);
      allItems.push(...result.items);
    }
    const rows = allItems.map(item => [item.createdAt, item.reference ?? '', item.type === 'entry' ? item.operation : `refused ${item.operation}: ${item.reason ?? ''}`, item.amountPaise ?? '', item.runningBalancePaise, item.status, item.initiator ?? '', item.counterparty ?? '']);
    const csv = ['Date,Reference,Description,Amount,Running balance,Status,Initiator,Counterparty', ...rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'ledgerline-statement.csv'; anchor.click(); URL.revokeObjectURL(url);
  }

  return <Panel title="Statements">
    <div className="statement-toolbar">
      <select value={selected} onChange={event => { setSelected(event.target.value); setPage(1); }}><option value="">Choose account</option>{accounts.map(account => <option value={account.id} key={account.id}>{account.displayName} · {account.maskedIdentifier}</option>)}</select>
      <input placeholder="Search this page" value={search} onChange={event => setSearch(event.target.value)} />
      <button className="ghost" onClick={() => void exportCsv()} disabled={!statement}>Export full CSV</button>
    </div>
    {error && <div className="error">{error}</div>}
    {statement ? <>
      <div className="statement-table"><div className="statement-row statement-head"><span>Date</span><span>Reference / activity</span><span>Debit</span><span>Credit</span><span>Balance</span><span>Status</span></div>
        {items.map(item => <div className="statement-row" key={`${item.type}-${item.id}`}>
          <span>{new Date(item.createdAt).toLocaleString()}</span>
          <span><strong>{item.reference ?? (item.type === 'refused_attempt' ? 'Refused attempt' : 'Ledger entry')}</strong><small>{item.type === 'entry' ? item.operation : `${item.operation} · ${item.reason ?? 'refused'}`} · {item.initiator ?? 'Unknown initiator'}</small></span>
          <span>{item.type === 'entry' && item.amountPaise?.startsWith('-') ? money((-BigInt(item.amountPaise)).toString()) : '—'}</span>
          <span>{item.type === 'entry' && item.amountPaise && !item.amountPaise.startsWith('-') ? money(item.amountPaise) : '—'}</span>
          <span>{money(item.runningBalancePaise)}</span><span>{item.status}</span>
        </div>)}
      </div>
      <div className="statement-toolbar"><span className="muted">{statement.pagination.totalRecords} records · Page {statement.pagination.page} of {Math.max(statement.pagination.totalPages, 1)}</span><button className="ghost" disabled={page <= 1} onClick={() => setPage(current => current - 1)}>Previous</button><button className="ghost" disabled={page >= statement.pagination.totalPages} onClick={() => setPage(current => current + 1)}>Next</button></div>
    </> : <div className="empty">{selected ? 'Loading statement…' : 'Choose an account to view its statement.'}</div>}
  </Panel>;
}
function TransactionsPage({ base, token }: { base: string; token: string }) { return <StatementsPage base={base} token={token} />; }
type AnalyticsData = {
  filters: { startDate: string; endDate: string; granularity: 'day' | 'week' | 'month'; accountId: string | null; transactionType: string | null; status: string | null };
  kpis: { deposits: string; withdrawals: string; transfers: string; transaction_count: string; successful_count: string; failed_count: string; active_accounts: string };
  trends: Array<{ period: string; deposits: string; withdrawals: string; transfers: string; transaction_count: string }>;

  balanceGrowth: Array<{ period: string; balance: string }>;
  distribution: Array<{ transaction_type: string; status: string; count: string; amount: string }>;

  accounts: Array<{ id: string; display_name: string; currency: string; balance_paise: string; status: string; transaction_count: string; volume_paise: string }>;

  reconciliation: { id: string; completed_at: string; discrepancy_count: number; status: string } | null;
};

function TrendChart({ rows, currency = 'INR' }: { rows: AnalyticsData['trends']; currency?: string }) {
  const width = 720; const height = 220; const pad = 30;
  const max = Math.max(1, ...rows.flatMap(row => [Number(row.deposits), Number(row.withdrawals), Number(row.transfers)]));
  const x = (index: number) => pad + (rows.length <= 1 ? 0 : index * (width - pad * 2) / (rows.length - 1));
  const y = (value: string) => height - pad - Number(value) / max * (height - pad * 2);
  const line = (key: 'deposits' | 'withdrawals' | 'transfers') => rows.map((row, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(row[key])}`).join(' ');
  return <div className="chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Deposits, withdrawals and transfers by period"><path className="chart-grid" d={`M${pad} ${height-pad}H${width-pad} M${pad} ${pad}H${width-pad}`} /><path className="chart-line deposits" d={line('deposits')} /><path className="chart-line withdrawals" d={line('withdrawals')} /><path className="chart-line transfers" d={line('transfers')} /></svg><div className="chart-legend"><span className="deposits-key">Deposits</span><span className="withdrawals-key">Withdrawals</span><span className="transfers-key">Transfers</span><span className="muted">{currency} · paise-derived</span></div><div className="chart-axis-labels">{rows.length > 0 && <><span>{rows[0].period}</span><span>{rows.at(-1)?.period}</span></>}</div></div>;
}

function BalanceChart({ rows }: { rows: AnalyticsData['balanceGrowth'] }) {
  const width = 720; const height = 180; const pad = 24; const max = Math.max(1, ...rows.map(row => Number(row.balance)));
  const points = rows.map((row, index) => `${index ? 'L' : 'M'} ${pad + (rows.length <= 1 ? 0 : index * (width - pad * 2) / (rows.length - 1))} ${height - pad - Number(row.balance) / max * (height - pad * 2)}`).join(' ');
  return <div className="chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Customer account balance growth"><path className="chart-grid" d={`M${pad} ${height-pad}H${width-pad} M${pad} ${pad}H${width-pad}`} /><path className="chart-line balance-line" d={points} /></svg><div className="chart-axis-labels">{rows.length > 0 && <><span>{rows[0].period}</span><span>{rows.at(-1)?.period}</span></>}</div></div>;
}

function AnalyticsPage({ base, token, user }: { base: string; token: string; user: User }) {
  const today = new Date().toISOString().slice(0, 10);
  const initialStart = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [preset, setPreset] = useState('30');
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day');
  const [startDate, setStartDate] = useState(initialStart);
  const [endDate, setEndDate] = useState(today);
  const [accountId, setAccountId] = useState('');
  const [transactionType, setTransactionType] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { api<{ accounts: Account[] }>(base, '/accounts', token).then(result => setAccounts(result.accounts)).catch(e => setError(e.message)); }, [base, token]);
  useEffect(() => {
    if (!startDate || !endDate) return;
    const params = new URLSearchParams({ startDate, endDate, granularity });
    if (accountId) params.set('accountId', accountId);
    if (transactionType) params.set('transactionType', transactionType);
    if (status) params.set('status', status);
    setLoading(true); setError('');
    api<AnalyticsData>(base, `/analytics?${params}`, token).then(setData).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [base, token, startDate, endDate, accountId, transactionType, status, granularity]);

  function setRange(days: number) { setPreset(String(days)); setGranularity(days === 90 ? 'week' : 'day'); setEndDate(today); setStartDate(new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)); }
  function downloadCsv() {
    if (!data) return;
    const rows = [['Period', 'Deposits paise', 'Withdrawals paise', 'Transfers paise', 'Transaction count'], ...data.trends.map(item => [item.period, item.deposits, item.withdrawals, item.transfers, item.transaction_count])];
    const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = `ledgerline-analytics-${startDate}-${endDate}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }
  const fmt = (paise: string) => money(paise);
  const titles = { deposits: 'Total deposits', withdrawals: 'Total withdrawals', transfers: 'Transfer volume' } as const;

  return <Panel title="Financial Analytics Dashboard">
    <div className="analytics-toolbar">
      <div className="segmented range-segment">{[7, 30, 90].map(days => <button key={days} className={preset === String(days) ? 'active' : ''} onClick={() => setRange(days)}>{days} days</button>)}<button className={preset === 'custom' ? 'active' : ''} onClick={() => setPreset('custom')}>Custom</button></div>
      <label>From<input type="date" value={startDate} onChange={event => { setPreset('custom'); setStartDate(event.target.value); }} /></label>
      <label>To<input type="date" value={endDate} onChange={event => { setPreset('custom'); setEndDate(event.target.value); }} /></label>
      <label>Account<select value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">All authorized accounts</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.displayName} · {account.maskedIdentifier}</option>)}</select></label>
      <label>Type<select value={transactionType} onChange={event => setTransactionType(event.target.value)}><option value="">All types</option>{['deposit','withdrawal','transfer','reversal'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{['posted','reversed','failed','pending'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Trend<select value={granularity} onChange={event => setGranularity(event.target.value as 'day' | 'week' | 'month')}><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option></select></label>
      <button className="ghost" onClick={downloadCsv} disabled={!data}>Export CSV</button><button className="ghost" onClick={() => window.print()} disabled={!data}>Save as PDF</button>
    </div>
    {error && <div className="error">{error}</div>}{loading && <div className="muted">Refreshing authorized ledger data…</div>}
    {data && <>
      <p className="muted">Real persisted records · {data.filters.startDate} through {data.filters.endDate} · {data.filters.granularity} buckets</p>
      <div className="analytics-kpis">{(Object.keys(titles) as Array<keyof typeof titles>).map(key => <article className="metric-card" key={key}><span>{titles[key]}</span><strong>{fmt(data.kpis[key])}</strong><small>INR · {key}</small></article>)}{[['active_accounts','Active accounts'],['transaction_count','Transactions'],['successful_count','Successful'],['failed_count','Failed / refused']].map(([key,title]) => <article className="metric-card" key={key}><span>{title}</span><strong>{data.kpis[key as keyof AnalyticsData['kpis']]}</strong><small>Selected date/filter scope</small></article>)}</div>
      <div className="analytics-charts"><section className="panel chart-panel"><h3>Cash movement by period</h3><TrendChart rows={data.trends} /></section><section className="panel chart-panel"><h3>Customer balance growth</h3><BalanceChart rows={data.balanceGrowth} /></section></div>
      <div className="analytics-charts"><section className="panel chart-panel"><h3>Transaction type and status</h3>{data.distribution.length ? <div className="distribution-list">{data.distribution.map(row => <div key={`${row.transaction_type}-${row.status}`}><span>{row.transaction_type} · {row.status}</span><strong>{row.count}</strong><small>{fmt(row.amount)} INR volume</small></div>)}</div> : <div className="empty">No matching transactions in this period.</div>}</section>
        <section className="panel chart-panel"><h3>Reconciliation</h3>{data.reconciliation ? <><strong>{data.reconciliation.discrepancy_count ? `${data.reconciliation.discrepancy_count} discrepancy finding(s)` : 'Latest run has no findings'}</strong><p className="muted">{new Date(data.reconciliation.completed_at).toLocaleString()} · {data.reconciliation.status}</p></> : <div className="empty">No persisted reconciliation run yet.</div>}{(user.roles.includes('ADMIN') || user.roles.includes('AUDITOR')) && <button className="ghost" onClick={() => { window.location.hash = '/reconciliation'; }}>Open reconciliation center</button>}</section></div>
      <section className="panel chart-panel"><h3>Account-wise summary</h3><div className="statement-table"><div className="statement-row statement-head"><span>Account</span><span>Status</span><span>Balance</span><span>Activity count</span><span>Activity volume</span><span>Currency</span></div>{data.accounts.map(account => <div className="statement-row" key={account.id}><span>{account.display_name}</span><span>{account.status}</span><span>{money(account.balance_paise)}</span><span>{account.transaction_count}</span><span>{money(account.volume_paise)}</span><span>{account.currency}</span></div>)}</div>{!data.accounts.length && <div className="empty">No accounts match the selected filters.</div>}</section>
    </>}
  </Panel>;
}
function NotificationsPage({ base, token }: { base: string; token: string }) { const [items, setItems] = useState<Array<{ id: string; event_type: string; metadata: unknown; created_at: string; is_read: boolean }>>([]); const [error, setError] = useState(''); useEffect(() => { api<{ notifications: typeof items }>(base, '/notifications', token).then(r => setItems(r.notifications)).catch(e => setError(e.message)); }, [base, token]); async function mark(id: string) { await api(base, `/notifications/${id}/read`, token, { method: 'POST' }); setItems(items.map(item => item.id === id ? { ...item, is_read: true } : item)); } return <Panel title="Notifications">{error && <div className="error">{error}</div>}{items.map(item => <div className={`notification-row ${item.is_read ? 'read' : 'unread'}`} key={item.id}><div><strong>{item.event_type}</strong><small>{new Date(item.created_at).toLocaleString()}</small></div>{!item.is_read && <button className="ghost" onClick={() => mark(item.id)}>Mark read</button>}</div>)}{!items.length && !error && <div className="empty">No notifications.</div>}</Panel>; }
function AdminPage({ base, token }: { base: string; token: string }) { const [summary, setSummary] = useState<unknown>(null); const [error, setError] = useState(''); useEffect(() => { api(base, '/admin/summary', token).then(setSummary).catch(e => setError(e.message)); }, [base, token]); return <Panel title="Admin Control Center"><p className="muted">User, account, audit, reconciliation and system controls are server-authorized.</p>{error && <div className="error">{error}</div>}{summary ? <pre className="data-view">{JSON.stringify(summary, null, 2)}</pre> : <div className="empty">Loading admin summary…</div>}</Panel>; }
function AuditPage({ base, token }: { base: string; token: string }) { const [data, setData] = useState<unknown>(null); const [error, setError] = useState(''); useEffect(() => { Promise.all([api(base, '/admin/audit/verify', token), api(base, '/admin/audit/events', token), api(base, '/admin/reconciliation', token), api(base, '/admin/risk/alerts', token)]).then(([verify, events, reconciliation, risk]) => setData({ verify, events, reconciliation, risk })).catch(e => setError(e.message)); }, [base, token]); return <Panel title="Audit Center"><p className="muted">Read-only ledger, audit, reconciliation and risk evidence.</p>{error && <div className="error">{error}</div>}{data ? <pre className="data-view">{JSON.stringify(data, null, 2)}</pre> : <div className="empty">Loading audit evidence…</div>}</Panel>; }
function ReconciliationPage({ base, token, user }: { base: string; token: string; user: User }) {
  const [history, setHistory] = useState<Array<{ id: string; status: string; completed_at: string | null; discrepancy_count: number }>>([]);
  const [findings, setFindings] = useState<Array<{ id: string; finding_type: string; severity: string; status: string; details: Record<string, unknown>; resolution_note?: string | null; investigated_by?: string | null }>>([]);
  const [schedule, setSchedule] = useState<{ enabled: boolean; cadence: 'daily' | 'weekly'; next_run_at: string | null } | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function load(runId?: string) {
    try {
      const result = await api<{ runs: typeof history }> (base, '/admin/reconciliation/history?page=1&pageSize=20', token);
      setHistory(result.runs);
      const selected = runId ?? result.runs[0]?.id;
      if (selected) { const data = await api<{ findings: typeof findings }>(base, `/admin/reconciliation/runs/${selected}/findings`, token); setFindings(data.findings); }
      else setFindings([]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load reconciliation history'); }
  }
  useEffect(() => {
    void load();
    api<{ schedule: typeof schedule }>(base, '/admin/reconciliation/schedule', token).then(result => setSchedule(result.schedule)).catch(e => setError(e.message));
  }, [base, token]);
  async function run() { setBusy(true); setError(''); try { const result = await api<{ id: string }>(base, '/admin/reconciliation/run', token, { method: 'POST' }); await load(result.id); } catch (e) { setError(e instanceof Error ? e.message : 'Reconciliation failed'); } finally { setBusy(false); } }
  async function updateFinding(finding: (typeof findings)[number], status: 'investigating' | 'resolved') {
    const resolutionNote = window.prompt(status === 'resolved' ? 'Resolution summary (no ledger correction will be made):' : 'Investigation note:');
    if (!resolutionNote) return;
    try { await api(base, `/admin/reconciliation/findings/${finding.id}`, token, { method: 'PATCH', body: JSON.stringify({ status, resolutionNote }) }); await load(history[0]?.id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to update finding'); }
  }
  async function saveSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schedule) return;
    try {
      const result = await api<{ schedule: typeof schedule }>(base, '/admin/reconciliation/schedule', token, { method: 'PUT', body: JSON.stringify(schedule) });
      setSchedule(result.schedule);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to update schedule'); }
  }
  return <Panel title="Reconciliation Center"><p className="muted">Compares customer balance snapshots with ledger sums and checks posted transaction balance, missing postings, and duplicate idempotency links. This workflow records evidence only; it never edits ledger history.</p>{error && <div className="error">{error}</div>}<div className="statement-toolbar"><button onClick={run} disabled={busy || !user.roles.includes('ADMIN')}>{busy ? 'Checking…' : 'Run reconciliation'}</button>{!user.roles.includes('ADMIN') && <span className="muted">Auditor role is read-only.</span>}</div>
    {schedule && <form className="schedule-form" onSubmit={saveSchedule}><label><input type="checkbox" checked={schedule.enabled} disabled={!user.roles.includes('ADMIN')} onChange={event => setSchedule({ ...schedule, enabled: event.target.checked })} /> Enable scheduled checks</label><label>Cadence<select value={schedule.cadence} disabled={!user.roles.includes('ADMIN')} onChange={event => setSchedule({ ...schedule, cadence: event.target.value as 'daily' | 'weekly' })}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><button disabled={!user.roles.includes('ADMIN')}>Save schedule</button><span className="muted">{schedule.next_run_at ? `Next run ${new Date(schedule.next_run_at).toLocaleString()}` : 'Scheduling is disabled'} · Requires the separate backend worker process.</span></form>}
    <div className="distribution-list">{history.map(run => <button className="ghost" key={run.id} onClick={() => void load(run.id)}>{new Date(run.completed_at ?? '').toLocaleString()} · {run.discrepancy_count} finding(s)</button>)}</div>{findings.map(finding => <article className="reconciliation-finding" key={finding.id}><div><span className={`severity ${finding.severity}`}>{finding.severity}</span><strong>{finding.finding_type}</strong><span className="account-status">{finding.status}</span><pre className="data-view">{JSON.stringify(finding.details, null, 2)}</pre>{finding.resolution_note && <p className="muted">Note: {finding.resolution_note}</p>}</div>{user.roles.includes('ADMIN') && finding.status !== 'resolved' && <div className="statement-toolbar"><button className="ghost" onClick={() => void updateFinding(finding, 'investigating')}>Investigate</button><button className="ghost" onClick={() => void updateFinding(finding, 'resolved')}>Resolve with note</button></div>}</article>)}{!findings.length && !error && <div className="empty">Select a run or execute reconciliation to see persisted findings.</div>}</Panel>;
}
function ScheduledPaymentsPage({ base, token, recurringOnly = false }: { base: string; token: string; recurringOnly?: boolean }) {
  type Payment = { id: string; source_account_id: string; destination_account_id: string; amount_paise: string; cadence?: 'once'; frequency?: 'daily' | 'weekly' | 'monthly'; status: string; next_run_at?: string; next_execution_at?: string; ends_at: string | null; description: string };
  type TransferAccount = { id: string; displayName: string; maskedIdentifier: string; status: string; currency: string };
  type Occurrence = { id: string; scheduled_for: string; status: string; attempt_count: number; transaction_id: string | null; last_error_code: string | null; attempts: Array<{ attemptNumber: number; status: string; errorCode: string | null; transactionId: string | null; createdAt: string }> };
  type PaymentDetail = { schedule?: Payment; payment?: Payment; executions: Occurrence[] };
  const [accounts, setAccounts] = useState<TransferAccount[]>([]); const [destinations, setDestinations] = useState<Array<Pick<TransferAccount, 'id' | 'displayName' | 'maskedIdentifier'>>>([]);
  const [payments, setPayments] = useState<Payment[]>([]); const [selected, setSelected] = useState<PaymentDetail | null>(null);
  const [source, setSource] = useState(''); const [destination, setDestination] = useState(''); const [amount, setAmount] = useState(''); const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('monthly'); const [executionDate, setExecutionDate] = useState(''); const [executionTime, setExecutionTime] = useState(''); const [startDate, setStartDate] = useState(''); const [endDate, setEndDate] = useState('');
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID()); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [destinationsLoading, setDestinationsLoading] = useState(false);

  const listPath = recurringOnly ? '/recurring-payments' : '/scheduled-payments';
  async function load() {
    setLoading(true); setError('');
    try {
      const [sourceResult, paymentResult] = await Promise.all([
        api<{ accounts: TransferAccount[] }>(base, '/scheduled-payments/eligible-accounts', token),
        api<{ schedules?: Payment[]; payments?: Payment[] }>(base, `${listPath}?page=1&pageSize=100`, token)
      ]);
      setAccounts(sourceResult.accounts); setPayments(recurringOnly ? paymentResult.payments ?? [] : paymentResult.schedules ?? []);
      setSource(current => sourceResult.accounts.some(account => account.id === current) ? current : '');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load payment accounts and plans'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [base, token, recurringOnly]);
  useEffect(() => {
    if (!source) { setDestinations([]); setDestination(''); setDestinationsLoading(false); return; }
    let active = true; setDestinations([]); setDestination(''); setDestinationsLoading(true); setError('');
    api<{ accounts: Array<Pick<TransferAccount, 'id' | 'displayName' | 'maskedIdentifier'>> }>(base, `/accounts/${source}/transfer-destinations`, token)
      .then(result => { if (active) setDestinations(result.accounts.filter(account => account.id !== source)); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Unable to load eligible destination accounts'); })
      .finally(() => { if (active) setDestinationsLoading(false); });
    return () => { active = false; };
  }, [base, token, source]);

  function localDateTime(date: string, time: string) {
    if (!date || !time) return null;
    const result = new Date(`${date}T${time}`);
    return Number.isFinite(result.getTime()) ? result : null;
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setError(''); setNotice('');
    if (!source || !destinations.some(account => account.id === destination)) { setError('Choose an authorized source and eligible destination account.'); return; }
    if (!amount || !description.trim()) { setError('Amount and description/reference are required.'); return; }
    const plannedAt = localDateTime(recurringOnly ? startDate : executionDate, executionTime);
    if (!plannedAt || plannedAt <= new Date()) { setError('Choose a valid future date and time.'); return; }
    if (recurringOnly && endDate && new Date(`${endDate}T23:59:59`) < plannedAt) { setError('End date must be on or after the start date.'); return; }
    setBusy(true);
    try {
      const payload = recurringOnly
        ? { sourceAccountId: source, destinationAccountId: destination, amountPaise: rupeesToPaise(amount), frequency, startAt: plannedAt.toISOString(), ...(endDate ? { endsAt: new Date(`${endDate}T23:59:59`).toISOString() } : {}), description: description.trim(), retryLimit: 3, retryDelayMinutes: 60, reminderMinutes: 1440 }
        : { sourceAccountId: source, destinationAccountId: destination, amountPaise: rupeesToPaise(amount), executeAt: plannedAt.toISOString(), description: description.trim(), retryLimit: 3, retryDelayMinutes: 60, reminderMinutes: 1440 };
      const result = await api<{ schedule?: Payment; payment?: Payment }>(base, listPath, token, { method: 'POST', headers: { 'Idempotency-Key': createKey }, body: JSON.stringify(payload) });
      const created = result.schedule ?? result.payment;
      if (!created) throw new Error('Server did not return the saved payment configuration');
      setNotice(`${recurringOnly ? 'Recurring payment' : 'One-time schedule'} saved · ${created.id}. Future execution requires the worker to be running.`);
      setCreateKey(crypto.randomUUID()); setAmount(''); setDescription(''); await load(); await inspect(created.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to create payment configuration'); }
    finally { setBusy(false); }
  }
  async function inspect(id: string) {
    try { setSelected(await api<PaymentDetail>(base, `${listPath}/${id}`, token)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to load payment execution history'); }
  }
  async function action(payment: Payment, verb: 'pause' | 'resume' | 'cancel') {
    if (verb === 'cancel' && !window.confirm('Cancel this payment plan? An already-started transfer cannot be recalled.')) return;
    try {
      await api(base, `${listPath}/${payment.id}/actions`, token, { method: 'POST', body: JSON.stringify({ action: verb }) });
      setNotice(`${recurringOnly ? 'Recurring payment' : 'Scheduled payment'} ${verb}d.`); await load(); await inspect(payment.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to update payment plan'); }
  }
  return <Panel title={recurringOnly ? 'Recurring Payments' : 'Scheduled Payments'}>
    <p className="muted">Internal INR transfers. Each occurrence uses the atomic ledger engine, sufficient-funds checks, and idempotency. Future execution requires the separately deployed worker.</p>
    {error && <div className="error" role="alert">{error}</div>}{notice && <div className="success" role="status">{notice}</div>}
    {loading && <div className="muted" role="status">Loading authorized accounts and saved plans…</div>}
    {!loading && accounts.length === 0 && <div className="empty">No active INR accounts that you can transfer from were found.</div>}
    <form className="schedule-create-form" onSubmit={create}>
      <label>Source Account<select required disabled={loading || !accounts.length} value={source} onChange={event => setSource(event.target.value)}><option value="">Choose authorized source account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.displayName} · {account.maskedIdentifier} · {account.currency}</option>)}</select></label>
      <label>Destination Account<select required disabled={!source || destinationsLoading || !destinations.length} value={destination} onChange={event => setDestination(event.target.value)}><option value="">{destinationsLoading ? 'Loading eligible destinations…' : source && !destinations.length ? 'No eligible destination accounts' : 'Choose eligible destination'}</option>{destinations.map(account => <option key={account.id} value={account.id}>{account.displayName} · {account.maskedIdentifier}</option>)}</select></label>
      <label>Amount (INR)<input required type="number" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} placeholder="25.00" /></label>
      {recurringOnly ? <>
        <label>Frequency<select required value={frequency} onChange={event => setFrequency(event.target.value as typeof frequency)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        <label>Start Date<input type="date" required value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
        <label>Execution Time<input type="time" required value={executionTime} onChange={event => setExecutionTime(event.target.value)} /></label>
        <label>Optional End Date<input type="date" min={startDate} value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
      </> : <>
        <label>Execution Date<input type="date" required value={executionDate} onChange={event => setExecutionDate(event.target.value)} /></label>
        <label>Execution Time<input type="time" required value={executionTime} onChange={event => setExecutionTime(event.target.value)} /></label>
      </>}
      <label>Description / Reference<input required maxLength={255} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <button disabled={busy || loading || destinationsLoading || !source || !destinations.some(account => account.id === destination)}>{busy ? 'Saving…' : recurringOnly ? 'Create Recurring Payment' : 'Create Schedule'}</button>
    </form>
    <div className="scheduled-list">{payments.map(payment => <article className="panel scheduled-card" key={payment.id}>
      <div className="scheduled-card-heading"><div><strong>{money(payment.amount_paise)} · {recurringOnly ? payment.frequency : 'one time'}</strong><small>{payment.description} · next {new Date(payment.next_execution_at ?? payment.next_run_at ?? '').toLocaleString()} · {payment.status}</small></div><div className="statement-toolbar"><button className="ghost" onClick={() => void inspect(payment.id)}>Execution history</button>{payment.status === 'active' && <button className="ghost" onClick={() => void action(payment,'pause')}>Pause</button>}{payment.status === 'paused' && <button className="ghost" onClick={() => void action(payment,'resume')}>Resume</button>}{['active','paused'].includes(payment.status) && <button className="ghost" onClick={() => void action(payment,'cancel')}>Cancel</button>}</div></div>
      {selected && (selected.schedule?.id === payment.id || selected.payment?.id === payment.id) && <div className="execution-list">{selected.executions.map(execution => <div className="admin-row" key={execution.id}><span>{new Date(execution.scheduled_for).toLocaleString()} · {execution.status} · attempt {execution.attempt_count}</span><span>{execution.transaction_id ?? execution.last_error_code ?? 'Pending'}</span><small>{execution.attempts.map(item => `#${item.attemptNumber} ${item.status}${item.errorCode ? ` (${item.errorCode})` : ''}`).join(' · ')}</small></div>)}{!selected.executions.length && <div className="empty">No execution yet.</div>}</div>}
    </article>)}{!payments.length && !loading && <div className="empty">No {recurringOnly ? 'recurring payments' : 'one-time schedules'} have been created.</div>}</div>
  </Panel>;
}

export function ModulePage({ page, base, token, user }: { page: string; base: string; token: string; user: User }) { if (page === 'Accounts') return <AccountsPage base={base} token={token} user={user} />; if (page === 'Statements') return <StatementsPage base={base} token={token} />; if (page === 'Transactions') return <TransactionsPage base={base} token={token} />; if (page === 'Analytics') return <AnalyticsPage base={base} token={token} user={user} />; if (page === 'Reconciliation') return <ReconciliationPage base={base} token={token} user={user} />; if (page === 'Notifications') return <NotificationsPage base={base} token={token} />; if (page === 'Admin') return <AdminPage base={base} token={token} />; if (page === 'Scheduled Payments') return <ScheduledPaymentsPage base={base} token={token} />; if (page === 'Recurring Payments') return <ScheduledPaymentsPage base={base} token={token} recurringOnly />; return <AuditPage base={base} token={token} />; }
