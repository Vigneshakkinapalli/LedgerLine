ALTER TABLE ledger_transactions
  ADD COLUMN source_account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD COLUMN destination_account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
  ADD COLUMN amount_paise BIGINT CHECK (amount_paise IS NULL OR amount_paise > 0);

CREATE INDEX ledger_transactions_approval_idx ON ledger_transactions(approval_status, created_at DESC);