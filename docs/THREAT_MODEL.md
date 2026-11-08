# Threat model

## Assets and trust boundaries

Assets include customer balances, credentials, JWTs, idempotency records, account permissions, ledger history, and audit evidence. Trust boundaries are the browser/API boundary, API/database boundary, operator/Admin boundary, test/production database boundary, and external settlement boundary.

## Implemented mitigations

Server-side JWT/session validation, role checks, ownership and permission checks protect API operations. Argon2id, generic credential errors, short-lived database-backed sessions, and logout revocation mitigate credential abuse. Unique idempotency keys plus request fingerprints limit replay. Deterministic account row locking and a deferred nonnegative-ledger check guard overdraft races. Posted ledger entries are append-only even after reversal; reversals append compensating entries. Parameterized SQL, JSON body limits, and login/transaction rate limits reduce injection and abuse. Admin role changes protect against self-change and removing the last Admin. Analytics global aggregates are Admin/Auditor-only. Notification read markers can only be created for events visible to that user. Integration tests use a fresh temporary local database, not the configured customer/development database. Destination discovery returns minimal masked fields.

## Accepted or residual risks

- Deposits and withdrawals model external money using clearing accounts; there are no payment rails, settlement reconciliation, or external proof of funds.
- Eligible active INR recipients are still enumerable to a user permitted to transfer from a source account; a controlled payee/allowlist workflow is not implemented.
- Rate limits are in-memory and do not coordinate across multiple API processes.
- Production TLS, secret rotation/management, MFA/account recovery, and deployment hardening remain operator responsibilities.
- Audit hash-chain verification is implemented, but the chain is not anchored to an external immutable store; a sufficiently privileged database operator could rewrite and recompute it.
- Direct SQL account-snapshot mutation is not prohibited by the schema; reconciliation detects snapshot drift but does not stop a privileged writer.
- The temporary test database runner is intentionally restricted to local PostgreSQL hosts. CI must provision a disposable local service/runner environment rather than point tests at a shared or remote database.
- The scheduled reconciliation worker must be supervised, monitored, and run against the same schema/database as the API. It is not a high-availability job queue; PostgreSQL row locking prevents duplicate claims for one configured schedule, but worker liveness/alerting is operational.
- Scheduled payments are internal INR transfers only. The worker persists unique occurrence and attempt keys with a lease; retryable insufficient-funds attempts use a new key. Worker process supervision, clock correctness, and operational alerting remain deployment responsibilities. High-value scheduled transfers are rejected rather than bypassing Admin approval.
- Finding resolution records an authorized human note and maker/checker identities; it does not perform any ledger correction. Any future corrective workflow requires a separately reviewed compensating-entry process.
- Analytics exposes global aggregates and account summaries only to Admin/Auditor roles. It is bounded to 366 days and 100 account rows; account-level privacy policy for auditors remains an organization decision.

Do not connect this prototype to real payment rails until the residual controls and operational requirements have been independently reviewed. MFA, recovery flows, bulk payments, multi-currency FX, and automated fraud decisions are not implemented.
