# API design

Foundation and authentication endpoints:

- `GET /health` — database-backed liveness/readiness check.
- `GET /api/v1/status` — service metadata.
- `POST /api/v1/validation/amount` — foundation-only validation probe; accepts `{ "amountPaise": "100" }` and returns a canonical string.
- `POST /api/v1/auth/register` — creates an account-holder user and customer account; returns a short-lived Bearer token.
- `POST /api/v1/auth/login` — Argon2 password verification with generic failures and login throttling.
- `POST /api/v1/auth/logout` — revokes the current database-backed JWT session.
- `GET /api/v1/auth/me` — returns the authenticated user and server-loaded roles.
- `GET /api/v1/accounts/:accountId` — account-holder ownership/permission access, with admin and auditor read access.
- `GET /api/v1/accounts/:accountId/transfer-destinations` — active INR customer accounts eligible as destinations for an authorized source account; excludes the source and returns masked labels.
- `GET /api/v1/accounts/:accountId/transactions` — enriched statement entries with running balance, initiator, counterparty, and refused-attempt records.
- `GET /api/v1/scheduled-payments` — owner-scoped schedule list with Admin/Auditor read access.
- `GET /api/v1/scheduled-payments/eligible-accounts` — active INR accounts owned by the caller or delegated with transfer permission, returned with masked identifiers.
- `POST /api/v1/scheduled-payments` — create a one-time future internal INR transfer from an owned or transfer-permitted account; requires an idempotency key and high-value schedules are rejected in favor of immediate Admin-approved transfers.
- `GET /api/v1/scheduled-payments/:scheduleId` — one-time schedule plus persisted occurrence and attempt history; non-owner IDs are hidden as 404.
- `POST /api/v1/scheduled-payments/:scheduleId/actions` — owner/Admin pause, resume, or cancel a one-time schedule.
- `GET|POST /api/v1/recurring-payments` — owner-scoped list and create a distinct daily/weekly/monthly recurring configuration; create requires an idempotency key.
- `GET /api/v1/recurring-payments/:paymentId` — recurring configuration plus occurrence/attempt history, owner-scoped.
- `POST /api/v1/recurring-payments/:paymentId/actions` — owner/Admin pause, resume, or cancel a recurrence.
- `POST /api/v1/accounts/:accountId/permissions` — ADMIN-only account permission grant.
- `PATCH /api/v1/accounts/:accountId/status` — ADMIN-only freeze/unfreeze/close control.
- `PUT /api/v1/accounts/:accountId/limits` — ADMIN-only daily paise limits.
- `POST /api/v1/accounts/:accountId/deposit` — authenticated, idempotent deposit against system clearing.
- `POST /api/v1/accounts/:accountId/withdraw` — authenticated, idempotent withdrawal with locked balance checks.
- `POST /api/v1/accounts/:accountId/transfer` — authenticated, idempotent balanced internal transfer.
- `POST /api/v1/transactions/:transactionId/approve` — ADMIN approval for high-value pending transfers.
- `POST /api/v1/transactions/:transactionId/reverse` — ADMIN compensating reversal.
- `GET /api/v1/transactions/:transactionId` — authorized transaction detail with ledger legs and audit timeline.
- `GET /api/v1/admin/reconciliation` — ADMIN/AUDITOR snapshot discrepancy report.
- `POST /api/v1/admin/reconciliation/run` and `GET /api/v1/admin/reconciliation/history` — run and inspect persisted reconciliation history.
- `GET /api/v1/admin/reconciliation/runs/:runId/findings` and `GET|PATCH /api/v1/admin/reconciliation/findings/:findingId` — inspect findings; Admin investigates and maker-checker resolves without modifying ledger records.
- `GET|PUT /api/v1/admin/reconciliation/schedule` — read/configure optional daily/weekly reconciliation; a separate worker is required.
- `GET /api/v1/admin/risk/alerts` — ADMIN/AUDITOR explainable refused-attempt report.
- `GET /api/v1/admin/audit/verify` — ADMIN/AUDITOR audit hash-chain verification result.
- `GET /api/v1/admin/audit/events` — ADMIN/AUDITOR append-only audit history.
- `GET /api/v1/admin/summary` — ADMIN/AUDITOR account and transaction summary.
- `GET /api/v1/admin/users` — ADMIN-only user listing without password hashes.
- `PUT /api/v1/admin/users/:userId/roles` — ADMIN-only role management with last-admin and self-change protections.

All responses may include `x-correlation-id`. Errors use a stable machine code and safe message. The complete contract is in `docs/openapi.yaml`.

Financial transfers and `Idempotency-Key` execution are implemented with the existing explicit SQL transaction and invariant rules; no external payment rails are connected.
