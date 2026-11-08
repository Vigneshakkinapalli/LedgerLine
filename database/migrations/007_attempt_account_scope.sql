ALTER TABLE transaction_attempts
  ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT;

CREATE INDEX transaction_attempts_account_idx
  ON transaction_attempts(account_id, created_at DESC)
  WHERE status <> 'accepted';