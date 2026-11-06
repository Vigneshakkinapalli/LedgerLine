# Database design

All identifiers are UUIDs and all timestamps are UTC `TIMESTAMPTZ`. Monetary values are PostgreSQL `BIGINT` paise. `ledger_entries.amount_paise` is signed: positive debit, negative credit; a posted transaction sums to zero. Customer accounts are normal user balances; system clearing accounts model external deposits and withdrawals.

`users`, `roles`, and `user_roles` establish identity. `accounts` has customer/system kind and status. `account_permissions` supports account-level access. `ledger_transactions` is the business posting envelope; `ledger_entries` are immutable movements. `idempotency_keys` uniquely binds a user request key to one transaction and response. `transaction_attempts` preserves refused/error attempts without pretending they posted. `audit_events` records actor, entity, and metadata. `account_limits` stores bounded daily controls.

Indexes cover owner lookup, transaction status, account statements, transaction lookup, attempts, and audit entity lookup. `ON DELETE RESTRICT` protects financial history. The migration runner records applied filenames in `schema_migrations`, runs each migration in a transaction, and never silently re-runs it.
