CREATE TABLE reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  discrepancy_count INTEGER NOT NULL DEFAULT 0 CHECK (discrepancy_count >= 0),
  correlation_id UUID,
  CHECK ((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
);
CREATE INDEX reconciliation_runs_history_idx ON reconciliation_runs(started_at DESC);

CREATE TABLE reconciliation_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  finding_type TEXT NOT NULL CHECK (finding_type IN ('BALANCE_MISMATCH', 'MISSING_POSTING', 'UNBALANCED_POSTING', 'DUPLICATE_IDEMPOTENCY_POSTING')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  resolution_note TEXT,
  investigated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  resolved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status <> 'resolved') OR (resolution_note IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX reconciliation_findings_run_idx ON reconciliation_findings(run_id, created_at);
CREATE INDEX reconciliation_findings_open_idx ON reconciliation_findings(status, severity, created_at DESC);

CREATE TABLE reconciliation_schedules (
  schedule_key SMALLINT PRIMARY KEY DEFAULT 1 CHECK (schedule_key = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekly')),
  next_run_at TIMESTAMPTZ,
  updated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR next_run_at IS NOT NULL)
);
INSERT INTO reconciliation_schedules (schedule_key, enabled, cadence, next_run_at)
VALUES (1, false, 'daily', NULL)
ON CONFLICT (schedule_key) DO NOTHING;
