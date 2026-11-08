CREATE TABLE recurring_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  destination_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  next_execution_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  description TEXT NOT NULL,
  retry_limit SMALLINT NOT NULL DEFAULT 3 CHECK (retry_limit BETWEEN 0 AND 10),
  retry_delay_minutes SMALLINT NOT NULL DEFAULT 60 CHECK (retry_delay_minutes BETWEEN 1 AND 1440),
  reminder_minutes SMALLINT NOT NULL DEFAULT 1440 CHECK (reminder_minutes BETWEEN 0 AND 10080),
  reminder_sent_for TIMESTAMPTZ,
  creation_request_key TEXT,
  creation_request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_account_id <> destination_account_id),
  CHECK (ends_at IS NULL OR ends_at >= next_execution_at),
  CHECK (creation_request_key IS NULL OR length(creation_request_key) BETWEEN 8 AND 255)
);
CREATE UNIQUE INDEX recurring_payments_owner_request_key_idx
  ON recurring_payments(owner_user_id, creation_request_key)
  WHERE creation_request_key IS NOT NULL;
CREATE INDEX recurring_payments_due_idx ON recurring_payments(next_execution_at, id) WHERE status = 'active';
CREATE INDEX recurring_payments_owner_idx ON recurring_payments(owner_user_id, created_at DESC);

CREATE TABLE recurring_payment_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_payment_id UUID NOT NULL REFERENCES recurring_payments(id) ON DELETE RESTRICT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at TIMESTAMPTZ,
  processing_until TIMESTAMPTZ,
  transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  last_error_code TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recurring_payment_id, scheduled_for),
  CHECK ((status = 'processing') = (processing_until IS NOT NULL))
);
CREATE INDEX recurring_payment_occurrences_due_idx ON recurring_payment_occurrences(next_retry_at, scheduled_for, id) WHERE status IN ('pending','processing');

CREATE TABLE recurring_payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id UUID NOT NULL REFERENCES recurring_payment_occurrences(id) ON DELETE RESTRICT,
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
CREATE INDEX recurring_payment_attempts_occurrence_idx ON recurring_payment_attempts(occurrence_id, attempt_number);

-- Preserve any legacy repeating schedules as recurring configurations, including occurrence/retry history.
INSERT INTO recurring_payments (
  id, owner_user_id, source_account_id, destination_account_id, amount_paise,
  frequency, status, next_execution_at, ends_at, description, retry_limit,
  retry_delay_minutes, reminder_minutes, reminder_sent_for, creation_request_key,
  creation_request_hash, created_at, updated_at
)
SELECT id, owner_user_id, source_account_id, destination_account_id, amount_paise,
       cadence, status, next_run_at, ends_at, description, retry_limit,
       retry_delay_minutes, reminder_minutes, reminder_sent_for, creation_request_key,
       creation_request_hash, created_at, updated_at
FROM scheduled_payments WHERE cadence IN ('daily','weekly','monthly')
ON CONFLICT (id) DO NOTHING;

INSERT INTO recurring_payment_occurrences (
  id, recurring_payment_id, scheduled_for, status, attempt_count, next_retry_at,
  processing_until, transaction_id, last_error_code, completed_at, created_at
)
SELECT o.id, o.schedule_id, o.scheduled_for, o.status, o.attempt_count,
       o.next_retry_at, o.processing_until, o.transaction_id, o.last_error_code,
       o.completed_at, o.created_at
FROM scheduled_payment_occurrences o
JOIN recurring_payments rp ON rp.id = o.schedule_id
ON CONFLICT (id) DO NOTHING;

INSERT INTO recurring_payment_attempts (
  id, occurrence_id, attempt_number, idempotency_key, status, transaction_id,
  response_status, error_code, created_at, completed_at
)
SELECT a.id, a.occurrence_id, a.attempt_number, a.idempotency_key, a.status,
       a.transaction_id, a.response_status, a.error_code, a.created_at, a.completed_at
FROM scheduled_payment_attempts a
JOIN recurring_payment_occurrences ro ON ro.id = a.occurrence_id
ON CONFLICT (id) DO NOTHING;

-- Preserve the original schedule/occurrence/attempt rows as an audit archive.
-- The new worker/API ignores non-once rows in scheduled_payments after the copy.
UPDATE scheduled_payments
SET status = 'cancelled', updated_at = now()
WHERE cadence IN ('daily','weekly','monthly') AND status IN ('active','paused');