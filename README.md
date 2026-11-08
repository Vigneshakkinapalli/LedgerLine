# LedgerLine

Money movement with a ledger you can prove.

LedgerLine now includes the Phase 1 foundation, authentication/RBAC, and a PostgreSQL-backed financial engine for deposits, withdrawals, internal transfers, idempotency, concurrency protection, reversals, reconciliation, and account risk controls. It does not connect to real payment rails.

## Local setup

1. Copy `.env.example` to `.env` and change secrets for any non-local use.
2. Install dependencies with npm.
3. Start PostgreSQL with Docker Compose.
4. Run the migration script, then the backend tests and typechecks. Use host port `5433`; Compose keeps PostgreSQL on container port `5432` to avoid conflicts with an existing host PostgreSQL.

The available commands are defined in the root and workspace `package.json` files. PostgreSQL client tools are not required on the host because Compose supplies the database.

The API is documented in `docs/openapi.yaml`. `RUN_DB_TESTS=1 npm test` creates a uniquely named temporary database on a local PostgreSQL server, applies all migrations, runs the API/schema integration suite, and drops only that temporary database. The test runner refuses remote PostgreSQL hosts. Plain `npm test` runs database-independent tests. See `docs/FINANCIAL_INVARIANTS.md`, `docs/THREAT_MODEL.md`, and `PROMPTS.md` before extending the transaction engine.

## Analytics and reconciliation

The Admin/Auditor Analytics page queries persisted ledger data and supports date, account, type, status, and day/week/month filters. CSV is generated from returned report data; “Save as PDF” opens the browser print dialog. Admins can run reconciliation immediately, review persisted run history/findings, and record an investigation or resolution note. Reconciliation does not fix or rewrite a ledger.

Optional scheduled reconciliation is disabled by default. Configure a daily/weekly schedule from the Reconciliation Center and run the separate worker process after building:

- `npm run build`
- `npm run worker`

The worker requires the same PostgreSQL configuration as the API and should be supervised as a separate deployment process. It also executes future-dated and daily/weekly/monthly internal INR transfer schedules. Each scheduled occurrence and retry is persisted with an idempotency key; crash recovery reuses the same key, while a later insufficient-funds retry uses a distinct key. High-value scheduled transfers are rejected instead of bypassing Admin approval. Bulk payments, MFA, multi-currency/FX, and payment-rail integration remain planned, not implemented.

## Development transfer recipient

Registration creates one customer account for each user. If a fresh database has only one customer account, use the registration form or `POST /api/v1/auth/register` to create a second development user/account. The transfer selector then loads eligible active customer accounts from `/transfer-destinations`; it never fabricates accounts in React.
