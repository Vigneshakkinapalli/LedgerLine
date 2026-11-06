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

Request flow: client -> correlation ID/CORS/body parsing -> authentication and Zod validation -> authorization/risk checks -> repository SQL -> transaction commit -> audit/response. The browser never decides authorization or balance sufficiency.

Database boundary: a financial operation uses one PostgreSQL transaction, locks source/destination accounts in deterministic order, records a refused attempt when appropriate, and commits balanced entries plus status and audit data together. Authentication operations use transactional database-backed sessions and audit events; financial transfers remain intentionally unimplemented.

The intended module boundaries are route/controller -> service -> repository, with database SQL isolated in repositories. Errors use `{ error: { code, message, details? } }`; validation is 400, authentication 401, authorization 403, conflict/idempotency 409, insufficient funds 422, and unexpected failures 500.
