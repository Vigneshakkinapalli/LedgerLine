# Prompt history

## 2026-11-06 — Phase 1 foundation

- **Task given to AI:** Build a production-minded LedgerLine Phase 1 foundation with React/Vite, Express/TypeScript, PostgreSQL migrations, financial invariants, documentation, tests, and verification.
- **What it generated:** An npm-workspaces monorepo foundation, PostgreSQL schema/migration runner, Express health endpoint and validation/error middleware, React shell, documentation, Docker Compose configuration, and tests.
- **Human verification required:** Install dependencies, start PostgreSQL, run migrations, compile both applications, and execute the test suite. Review schema constraints and security assumptions before using any financial endpoint.
- **Actual defect discovered:** The first typecheck exposed missing React and Supertest declaration packages; Docker verification also exposed that the local Docker Desktop Linux engine is not running. These are setup/verification defects, not financial-logic defects.
- **Corrective action:** Added `@types/supertest`, `@types/react`, and `@types/react-dom`; compilation and tests then passed. Added opt-in real-database integration tests. PostgreSQL verification remains pending until Docker Desktop is started. `npm audit` reports 7 advisories whose fixes require breaking upgrades; no forced upgrade was applied.
- **Corrective action / commit:** Pending repository commit.

## 2026-11-06 — Authentication and enterprise RBAC

- **Task given to AI:** Continue the existing LedgerLine codebase with Argon2 authentication, short-lived JWT sessions, ADMIN/ACCOUNT_HOLDER/AUDITOR RBAC, ownership and permission enforcement, admin role management, audit events, login rate limiting, and real security tests without implementing transfers.
- **What it generated:** Additive `002_auth_sessions.sql` migration; registration, login, logout, current-user, account access, account permission, and admin role endpoints; centralized authentication/RBAC middleware; transactional session/audit operations; real PostgreSQL integration tests.
- **What needs human verification:** Review production secret provisioning, TLS, distributed rate-limit storage, MFA/account recovery requirements, and the authorization policy before production use.
- **Actual defect discovered:** Migration execution initially resolved `database/migrations` relative to the backend workspace and failed with `ENOENT`; the runner was corrected to support both workspace and repository-root working directories.
- **Corrective action:** Added candidate-path discovery, reran the migration, and verified the complete database-backed suite passed 14/14.

## 2026-11-06 — Financial engine and live dashboard

- **Task given to AI:** Complete deposits, withdrawals, transfers, double-entry posting, idempotency, concurrency protection, rollback behavior, reversals, reconciliation, risk controls, frontend workflows, OpenAPI documentation, and real tests without weakening prior security or ledger constraints.
- **What it generated:** Additive financial migration, atomic PostgreSQL posting service, deterministic account locking, canonical idempotency fingerprints, compensating reversals, append-only audit hash trigger, reconciliation/risk endpoints, freeze/limit controls, live account dashboard/forms/statements, OpenAPI document, and PostgreSQL integration tests.
- **What needs human verification:** Review high-value approval policy, production rate-limit storage, settlement semantics for clearing accounts, operational alerting, TLS/secret rotation, and frontend deployment configuration before production use.
- **Actual defects discovered:** Optional destination status validation initially refused all deposits/withdrawals; this was corrected. The frontend also initially lacked Vite ambient types; adding the standard declaration fixed the build.
- **Corrective action:** Reran the real integration suite after both fixes; all 23 database/API/auth/financial tests passed.

## 2026-11-06 — Running application integration fix

- **Task given to AI:** Audit and repair the running React → Express → PostgreSQL application, verify account listing and real browser workflows, and preserve the financial/security tests.
- **What it generated:** No new modules; corrected the existing account-list query parameter binding and added integration coverage for account-list ownership.
- **Actual defect discovered:** `GET /api/v1/accounts` passed three PostgreSQL parameters to a query using only `$1` and `$2`, causing `08P01` and the dashboard's generic error.
- **Corrective action:** Removed the unused parameter, verified browser registration/login/account listing/deposit/withdrawal/transfer/statement flows, and reran the real suite successfully.
- **Additional defects discovered:** Successful UI postings refreshed balances but not the statement panel; Vite HMR also reported duplicate React root creation during development.
- **Additional corrective action:** Reloaded the selected statement after postings, reused the React root across HMR reloads, added statement integration coverage, and reverified the browser dashboard without new console/network errors.

## 2026-11-06 — Transfer destination selection fix

- **Task given to AI:** Fix the empty destination dropdown without weakening account ownership, display friendly masked account labels, support safe second-account development setup, and verify a real transfer end to end.
- **What it generated:** A dedicated authenticated `GET /api/v1/accounts/:accountId/transfer-destinations` query, source permission enforcement, active INR customer filtering, source exclusion, masked labels, frontend destination state/loading/error handling, and integration assertions for authorized/unauthorized access.
- **Actual defect discovered:** The frontend reused ownership-scoped `/accounts` results for destinations, so a holder with one owned account saw no destination. The source user's account list was correctly not exposing other owners' accounts.
- **Corrective action:** Added the purpose-built eligible-destination endpoint and registration-based development recipient process. Browser transfer returned `201`; PostgreSQL recorded a posted transfer with 2 ledger legs summing to zero. Full real suite remained passing.

## 2026-11-06 — Advanced account and reporting extension

- **Task given to AI:** Extend the existing project with additive account, statement, admin, auditor, audit-integrity, analytics, notification, and navigation features without replacing the existing dashboard or financial engine.
- **What it generated:** Enriched persisted statements with running balances, initiators, counterparties, and refused attempts; analytics, notifications, admin summary, audit history/hash verification endpoints; role-aware navigation and live-data auxiliary pages; OpenAPI updates and integration tests.
- **What needs human verification:** Full statement date/search/pagination/CSV UX, dedicated polished admin/auditor visual dashboards, and a production-safe fixture/demo data lifecycle still require follow-up.
- **Actual limitation discovered:** Existing integration tests persist `@example.test` users/accounts in the shared development database, and the current destination endpoint intentionally returns active customer accounts. Fixture isolation cannot be truthfully claimed without a fixture marker/lifecycle change.
- **Corrective action:** No fake records or destructive cleanup was introduced; the limitation is documented for the next safe migration/test-fixture change.

## 2026-11-06 — Rupee conversion, statements, and routing fix

- **Task given to AI:** Fix rupee-to-paise conversion, replace raw statement JSON with a real statement page, and make navigation pages distinct and refresh-safe while preserving the existing dashboard and financial engine.
- **What it generated:** Exact string-based `rupeesToPaise` conversion, rupee-denominated movement input, statement table with running balances/initiators/counterparties/refused-attempt notice/search/CSV export, hash navigation, dedicated Analytics/Accounts/Statements views, and frontend regression tests.
- **Actual defects discovered:** The frontend sent rupee text directly as `amountPaise`; Statements was mapped to `/accounts` and rendered as raw JSON; Analytics and other pages shared one auxiliary renderer; analytics initially summed nullable transaction envelope amounts and showed zero for legacy deposits/withdrawals.
- **Corrective action:** Converted ₹22 to 2200 paise at the frontend boundary, derived analytics from persisted ledger legs, added route/page rendering and tests, and verified a real browser deposit posted 2200 paise and displayed ₹22.00.
