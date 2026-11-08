ALTER TABLE users ADD COLUMN full_name TEXT;

ALTER TABLE scheduled_payments
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD COLUMN creation_request_key TEXT,
  ADD COLUMN creation_request_hash TEXT;

ALTER TABLE scheduled_payments
  ADD CONSTRAINT scheduled_payments_creation_request_key_length
  CHECK (creation_request_key IS NULL OR length(creation_request_key) BETWEEN 8 AND 255);

CREATE UNIQUE INDEX scheduled_payments_owner_request_key_idx
  ON scheduled_payments(owner_user_id, creation_request_key)
  WHERE creation_request_key IS NOT NULL;
