# Deploying LedgerLine to Render

The repository contains a Render Blueprint (`render.yaml`) that provisions the PostgreSQL database, the Express API, the background worker and the static frontend.

## 1. Connect the repository

1. Sign in to https://dashboard.render.com and click **New → Blueprint**.
2. Select the GitHub repository `Vigneshakkinapalli/LedgerLine`, branch `main`.
3. Render reads `render.yaml` and shows the planned resources: `ledgerline-db` (PostgreSQL 16), `ledgerline-api` (web service), `ledgerline-worker` (background worker), `ledgerline-frontend` (static site).
4. Review the plan each service is configured with (`starter` for paid services, `free` for the static site) and close the prompt to apply the blueprint. **Approval is requested here because this creates paid resources.**

## 2. Fill the two hand-off environment variables

The URLs of the generated services are not known before the first deploy, so the blueprint marks two variables `sync: false`. After the first deploy, set them and redeploy:

| Service | Variable | Value |
|---------|----------|-------|
| `ledgerline-api` | `CORS_ORIGIN` | `https://<frontend-domain>.onrender.com` |
| `ledgerline-frontend` | `VITE_API_URL` | `https://<api-domain>.onrender.com/api/v1` |

`VITE_API_URL` is a build-time variable: after saving it, use **Manual Deploy → Clear build cache & deploy** on the frontend so Vite bakes it in.

## 3. Secrets

- `JWT_SECRET` is generated automatically by the blueprint (`generateValue: true`) and never appears in Git.
- `DATABASE_URL` is injected from the managed database connection string.
- No secrets live in `render.yaml`, `.env` or the repository. Local development continues to use `.env` (gitignored).

## 4. Database migrations

`ledgerline-api` runs `node dist/src/db/migrate.js` as its **Pre-Deploy Command**, so every deploy applies pending SQL migrations in `database/migrations/` before the new API starts. Migrations are tracked in `schema_migrations` and are idempotent (already-applied files are skipped). The worker does not run migrations; deploy the API first (or together) and the worker attaches afterwards.

## 5. Runtime behaviour

- The API binds to `0.0.0.0:$PORT` (Render's injected port) and exposes `GET /health` returning database connectivity — used as the health check path.
- The worker polls every 60 seconds for due scheduled payments, recurring payments and scheduled reconciliation. It is safe to run alongside API instances: occurrences are claimed with `FOR UPDATE ... SKIP LOCKED`, every transfer runs through the atomic ledger engine with a unique idempotency key, and funding failures retry per the configured retry policy.
- All money is stored as integer paise; the API refuses any non-integer or non-positive amounts.
- Auditors are read-only everywhere; public signup always creates `ACCOUNT_HOLDER` users only.

## 6. Post-deploy verification

1. `https://<api-domain>/health` → `{"status":"ok","database":"ok"}`.
2. Open the frontend URL: register an account (redirects to Login), log in, create an INR account on the Accounts page (registration auto-creates one), deposit ₹100, schedule a payment 15 minutes ahead, and with the worker running confirm the transfer executes when the time passes (Notifications shows `SCHEDULED_PAYMENT_EXECUTED`).
3. Statements, scheduled and recurring payment lists should all reflect real database rows.
