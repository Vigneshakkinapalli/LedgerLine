# Architecture

LedgerLine is a modular monolith: one deployable API, one PostgreSQL database, and a React client.

```text
React/Vite browser
      | HTTPS + JWT, correlation ID
Express API
  auth | users | accounts | ledger | transactions | idempotency
  audit | reconciliation | risk | admin
      | pg Pool; explicit SQL; one transaction per posting
PostgreSQL (schema constraints, triggers, migrations, audit trail)
```

Request flow: client -> correlation ID/CORS/body parsing -> authentication and Zod validation -> authorization/risk checks -> service-layer parameterized SQL -> transaction commit -> audit/response. The browser never decides authorization or balance sufficiency. SQL is currently issued by services/routes through the shared `pg` pool; there is no separate repository layer yet.

Database boundary: deposits, withdrawals, transfers, approvals, and reversals use PostgreSQL transactions. Financial operations lock source/destination accounts in deterministic ID order, record account-scoped refused attempts, and commit balanced entries, snapshots, idempotency results, and audit events together. Internal transfers are implemented. Deposits and withdrawals are simulations against system clearing accounts; external payment rails, settlement, and bank connectivity are not implemented. Posted ledger entries, including entries on reversed transactions, are append-only under migration `006_immutable_ledger_entries.sql`.

Analytics is a filtered global aggregate endpoint restricted to Admin and Auditor roles. Its trends, account balances, transaction counts and volumes are queried from PostgreSQL; exports are client-side CSV or browser print-to-PDF. Reconciliation compares account snapshots, posted transaction totals, missing postings, and duplicate idempotency links. Runs/findings are persisted; investigation and resolution notes require Admin, with a different Admin required to resolve an investigated finding. These workflow endpoints never correct ledger entries. Optional daily/weekly schedules are persisted and processed by the separate `npm run worker` process, using `FOR UPDATE SKIP LOCKED` so multiple worker instances do not claim one due schedule twice. Deploy the worker independently of API processes.

Holder statements are account-authorized, paginated activity timelines containing ledger entries and account-scoped refused attempts; attempt activity does not change running balance. Destination discovery requires access to the source account and returns only a generic recipient label and masked identifier, but the eligible-recipient set remains enumerable to such a source user.

Errors use `{ error: { code, message, details? } }`; validation is 400, authentication 401, authorization 403, conflict/idempotency 409, refused financial operations 422, and unexpected failures 500. With `RUN_DB_TESTS=1 npm test`, the repository test runner creates a fresh local disposable PostgreSQL database, migrates it, and removes it after the suite; remote DB hosts are rejected by the runner.

Analytics currently supports a maximum 366-day date window, one account/type/status filter and day/week/month buckets. Scheduled reconciliation supports daily or weekly cadence. Future-dated and daily/weekly/monthly internal INR transfers use persisted schedules, occurrences, and attempts. Retry attempts use stable idempotency keys; crash recovery replays the same attempt key and insufficient-funds retries get a new attempt key. High-value scheduled transfers are rejected to prevent bypassing the existing Admin approval flow. Bulk payments, holds, MFA, multi-currency/FX, and automated fraud decisions are not implemented. The worker is not a general-purpose durable job queue or HA scheduler.
