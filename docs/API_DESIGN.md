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
- `GET /api/v1/admin/risk/alerts` — ADMIN/AUDITOR explainable refused-attempt report.
- `GET /api/v1/admin/audit/verify` — ADMIN/AUDITOR audit hash-chain verification result.
- `GET /api/v1/admin/audit/events` — ADMIN/AUDITOR append-only audit history.
- `GET /api/v1/admin/summary` — ADMIN/AUDITOR account and transaction summary.
- `GET /api/v1/admin/users` — ADMIN-only user listing without password hashes.
- `PUT /api/v1/admin/users/:userId/roles` — ADMIN-only role management with last-admin and self-change protections.

All responses may include `x-correlation-id`. Errors use a stable machine code and safe message. The complete contract is in `docs/openapi.yaml`.

Financial transfers and `Idempotency-Key` execution are implemented with the existing explicit SQL transaction and invariant rules; no external payment rails are connected.
