CREATE TABLE scheduled_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  destination_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  cadence TEXT NOT NULL CHECK (cadence IN ('once', 'daily', 'weekly', 'monthly')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  next_run_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  retry_limit SMALLINT NOT NULL DEFAULT 3 CHECK (retry_limit BETWEEN 0 AND 10),
  retry_delay_minutes SMALLINT NOT NULL DEFAULT 60 CHECK (retry_delay_minutes BETWEEN 1 AND 1440),
  reminder_minutes SMALLINT NOT NULL DEFAULT 1440 CHECK (reminder_minutes BETWEEN 0 AND 10080),
  reminder_sent_for TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_account_id <> destination_account_id),
  CHECK (ends_at IS NULL OR ends_at >= next_run_at)
);
CREATE INDEX scheduled_payments_due_idx ON scheduled_payments(next_run_at, id) WHERE status = 'active';
CREATE INDEX scheduled_payments_owner_idx ON scheduled_payments(owner_user_id, created_at DESC);

CREATE TABLE scheduled_payment_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES scheduled_payments(id) ON DELETE RESTRICT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TIMESTAMPTZ,
  processing_until TIMESTAMPTZ,
  transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  last_error_code TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, scheduled_for),
  CHECK ((status = 'processing') = (processing_until IS NOT NULL))
);
CREATE INDEX scheduled_payment_occurrences_due_idx ON scheduled_payment_occurrences(next_retry_at, scheduled_for, id) WHERE status IN ('pending', 'processing');

CREATE TABLE scheduled_payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id UUID NOT NULL REFERENCES scheduled_payment_occurrences(id) ON DELETE RESTRICT,
  attempt_number SMALLINT NOT NULL CHECK (attempt_number > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'succeeded', 'retryable_failure', 'terminal_failure')),
  transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  response_status INTEGER,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (occurrence_id, attempt_number)
);
CREATE INDEX scheduled_payment_attempts_occurrence_idx ON scheduled_payment_attempts(occurrence_id, attempt_number);
