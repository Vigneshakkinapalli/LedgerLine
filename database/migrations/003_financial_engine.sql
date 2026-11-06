ALTER TABLE ledger_transactions
  ADD COLUMN transaction_type TEXT NOT NULL DEFAULT 'transfer' CHECK (transaction_type IN ('deposit', 'withdrawal', 'transfer', 'reversal')),
  ADD COLUMN reversal_of UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('approved', 'pending', 'rejected')),
  ADD COLUMN approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN risk_reason TEXT;

ALTER TABLE transaction_attempts
  ADD COLUMN operation TEXT NOT NULL DEFAULT 'transfer' CHECK (operation IN ('deposit', 'withdrawal', 'transfer', 'reversal'));

ALTER TABLE audit_events
  ADD COLUMN previous_hash TEXT,
  ADD COLUMN event_hash TEXT;

CREATE OR REPLACE FUNCTION append_audit_hash() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_value TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ledgerline_audit_hash_chain'));
  SELECT event_hash INTO previous_value FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE;
  NEW.previous_hash := previous_value;
  NEW.event_hash := encode(digest(
    COALESCE(previous_value, '') || '|' || NEW.event_type || '|' || NEW.entity_type || '|' || COALESCE(NEW.entity_id::text, '') || '|' || NEW.metadata::text || '|' || NEW.created_at::text,
    'sha256'
  ), 'hex');
  RETURN NEW;
END; $$;
CREATE TRIGGER audit_events_hash_chain BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION append_audit_hash();

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END; $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE OR REPLACE FUNCTION reject_posted_transaction_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status NOT IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'posted transactions are immutable';
  END IF;
  IF OLD.status = 'posted' AND (NEW.reference <> OLD.reference OR NEW.currency <> OLD.currency OR NEW.transaction_type <> OLD.transaction_type) THEN
    RAISE EXCEPTION 'posted transaction fields are immutable';
  END IF;
  RETURN NEW;
END; $$;

INSERT INTO accounts (code, kind, currency)
VALUES ('SYSTEM_CLEARING_IN', 'system', 'INR'), ('SYSTEM_CLEARING_OUT', 'system', 'INR')
ON CONFLICT (code) DO NOTHING;

INSERT INTO account_limits (account_id, daily_debit_limit_paise, daily_credit_limit_paise)
SELECT id, 100000000, 100000000 FROM accounts
WHERE kind = 'customer'
ON CONFLICT (account_id) DO NOTHING;
