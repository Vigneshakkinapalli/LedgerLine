# LedgerLine Threats and Accepted Risks

## Protected assets and boundaries

Protected assets include customer balances, credentials, sessions, account permissions, idempotency records, immutable ledger entries, reconciliation findings, and audit evidence. Trust boundaries are the browser/API, API/PostgreSQL, Admin/operator, test/production database, and external settlement boundaries.

## Implemented controls

- Argon2id password hashing, generic login failures, short-lived JWTs backed by revocable PostgreSQL sessions.
- Server-side role, owner, delegated-permission, and account-state checks on financial actions.
- Parameterized SQL, Zod request validation, JSON body limits, and login/transaction rate limits.
- Request fingerprints and unique idempotency keys; deterministic account row locks; PostgreSQL nonnegative-balance and zero-sum posting constraints.
- Compensating reversals; immutable ledger-entry UPDATE/DELETE trigger remains in force after reversal.
- Append-only audit records and hash-chain verification. Reconciliation compares customer snapshots to ledger sums, checks posted transaction balance/missing postings and duplicate idempotency links, and persists run/findings.
- Analytics exposes global financial aggregates only to Admin/Auditor roles. Notification read markers are scoped to visible events.
- Reconciliation resolution requires an investigation and a different Admin, stores a note, and does not modify ledger entries.
- Scheduled reconciliation uses a database row lock with `SKIP LOCKED`; integration tests run in a disposable local PostgreSQL database.
- Scheduled internal transfers persist unique occurrences and per-attempt idempotency keys; leases recover crashed attempts, retries use a new key, and concurrent worker polling does not create duplicate postings. High-value scheduled transfers are rejected instead of bypassing Admin approval.
- Scheduled-payment reminders and execution/failure audit events are exposed only through the existing authenticated user-scoped notification query.

## Accepted / residual risks

- Deposits/withdrawals are clearing-account simulations; no external payment rails, settlement, or proof of funds are connected.
- Eligible recipients remain enumerable to users allowed to transfer from an account, although responses are minimized and masked.
- In-memory rate limiting does not coordinate across API replicas. Reconciliation and payment schedules require a separately supervised worker and are not a durable general-purpose job queue.
- Audit hashes are not anchored externally; a privileged database operator could rewrite and recompute chain values.
- Direct privileged SQL can alter balance snapshots; reconciliation detects but does not prevent this.
- MFA, account recovery, device management, multi-currency/FX, bulk payments, holds/refunds, and automated fraud intelligence are not implemented. Scheduled payments are internal INR transfers only; no external payment rails are connected.
- Production TLS, secret rotation, deployment hardening, observability/alert delivery, and operational incident response remain deployment responsibilities.

Do not connect LedgerLine to real payment rails without independent security, accounting, compliance, and operational review. See `docs/THREAT_MODEL.md` for additional context.
