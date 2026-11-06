CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_status AS ENUM ('active', 'frozen', 'closed');
CREATE TYPE transaction_status AS ENUM ('pending', 'posted', 'failed', 'reversed');
CREATE TYPE attempt_status AS ENUM ('accepted', 'refused', 'error');
CREATE TYPE account_kind AS ENUM ('customer', 'system');

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE CHECK (name <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  kind account_kind NOT NULL,
  status account_status NOT NULL DEFAULT 'active',
  currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0 OR kind = 'system'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'customer' AND owner_user_id IS NOT NULL) OR (kind = 'system' AND owner_user_id IS NULL))
);
CREATE UNIQUE INDEX one_customer_account_per_owner_currency ON accounts(owner_user_id, currency) WHERE kind = 'customer';
CREATE INDEX accounts_owner_idx ON accounts(owner_user_id);

CREATE TABLE account_permissions (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'deposit', 'withdraw', 'transfer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id, permission)
);

CREATE TABLE ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  status transaction_status NOT NULL DEFAULT 'pending',
  currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key_id UUID,
  initiated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ
);
CREATE INDEX ledger_transactions_status_idx ON ledger_transactions(status, created_at DESC);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_paise BIGINT NOT NULL CHECK (amount_paise <> 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, account_id),
  CHECK (amount_paise BETWEEN -9223372036854775807 AND 9223372036854775807)
);
CREATE INDEX ledger_entries_account_statement_idx ON ledger_entries(account_id, created_at DESC, id);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries(transaction_id);

CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  request_hash TEXT NOT NULL,
  transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_idempotency_fk FOREIGN KEY (idempotency_key_id) REFERENCES idempotency_keys(id) ON DELETE RESTRICT;

CREATE TABLE transaction_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  status attempt_status NOT NULL,
  reason_code TEXT,
  amount_paise BIGINT CHECK (amount_paise IS NULL OR amount_paise > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transaction_attempts_lookup_idx ON transaction_attempts(user_id, created_at DESC);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);

CREATE TABLE account_limits (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  daily_debit_limit_paise BIGINT NOT NULL CHECK (daily_debit_limit_paise > 0),
  daily_credit_limit_paise BIGINT NOT NULL CHECK (daily_credit_limit_paise > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_posted_entry_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.transaction_id IN (SELECT id FROM ledger_transactions WHERE status = 'posted') THEN
    RAISE EXCEPTION 'posted ledger entries are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_posted_entry_mutation();

CREATE OR REPLACE FUNCTION validate_posted_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total BIGINT;
BEGIN
  IF NEW.status = 'posted' THEN
    SELECT COALESCE(SUM(amount_paise), 0) INTO total FROM ledger_entries WHERE transaction_id = NEW.id;
    IF total <> 0 THEN RAISE EXCEPTION 'posted transaction must balance to zero'; END IF;
    IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = NEW.id) THEN RAISE EXCEPTION 'posted transaction requires ledger entries'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER posted_transaction_balanced AFTER INSERT OR UPDATE ON ledger_transactions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_posted_transaction();

CREATE OR REPLACE FUNCTION validate_customer_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_kind_value account_kind; calculated BIGINT;
BEGIN
  SELECT kind INTO account_kind_value FROM accounts WHERE id = NEW.account_id;
  IF account_kind_value = 'customer' THEN
    SELECT COALESCE(SUM(amount_paise), 0) INTO calculated FROM ledger_entries WHERE account_id = NEW.account_id;
    IF calculated < 0 THEN RAISE EXCEPTION 'customer account balance cannot become negative'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER customer_balance_nonnegative AFTER INSERT OR UPDATE ON ledger_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_customer_balance();

CREATE OR REPLACE FUNCTION reject_posted_transaction_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND (NEW.status <> OLD.status OR NEW.reference <> OLD.reference OR NEW.currency <> OLD.currency) THEN
    RAISE EXCEPTION 'posted transactions are immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION reject_posted_transaction_mutation();
