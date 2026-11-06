# LedgerLine

Money movement with a ledger you can prove.

LedgerLine now includes the Phase 1 foundation, authentication/RBAC, and a PostgreSQL-backed financial engine for deposits, withdrawals, internal transfers, idempotency, concurrency protection, reversals, reconciliation, and account risk controls. It does not connect to real payment rails.

## Local setup

1. Copy `.env.example` to `.env` and change secrets for any non-local use.
2. Install dependencies with npm.
3. Start PostgreSQL with Docker Compose.
4. Run the migration script, then the backend tests and typechecks. Use host port `5433`; Compose keeps PostgreSQL on container port `5432` to avoid conflicts with an existing host PostgreSQL.

The available commands are defined in the root and workspace `package.json` files. PostgreSQL client tools are not required on the host because Compose supplies the database.

The API is documented in `docs/openapi.yaml`. Use `RUN_DB_TESTS=1 npm test` for the real PostgreSQL integration suite; plain `npm test` runs only the database-independent tests. See `docs/FINANCIAL_INVARIANTS.md`, `docs/THREAT_MODEL.md`, and `PROMPTS.md` before extending the transaction engine.

## Development transfer recipient

Registration creates one customer account for each user. If a fresh database has only one customer account, use the registration form or `POST /api/v1/auth/register` to create a second development user/account. The transfer selector then loads eligible active customer accounts from `/transfer-destinations`; it never fabricates accounts in React.
