-- Migration 007 introduced account_id but existing refused attempts were left NULL.
-- Refusal and audit rows are written in one transaction, so PostgreSQL now() timestamps
-- and their actor/reason metadata identify the source account without guessing.
UPDATE transaction_attempts ta
SET account_id = ae.entity_id
FROM audit_events ae
WHERE ta.account_id IS NULL
  AND ta.transaction_id IS NULL
  AND ta.status = 'refused'
  AND ae.event_type = 'TRANSACTION_REFUSED'
  AND ae.entity_type = 'account'
  AND ae.entity_id IS NOT NULL
  AND ae.actor_user_id = ta.user_id
  AND ae.created_at = ta.created_at
  AND ae.metadata->>'operation' = ta.operation
  AND ae.metadata->>'reason' = ta.reason_code
  AND ae.metadata->>'amountPaise' = ta.amount_paise::text;

-- Link accepted attempts to their customer-side posting account where possible.
UPDATE transaction_attempts ta
SET account_id = COALESCE(
  (SELECT lt.source_account_id FROM ledger_transactions lt WHERE lt.id = ta.transaction_id),
  (SELECT le.account_id
   FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
   WHERE le.transaction_id = ta.transaction_id AND a.kind = 'customer'
   ORDER BY CASE WHEN le.amount_paise < 0 THEN 0 ELSE 1 END, le.account_id
   LIMIT 1)
)
WHERE ta.account_id IS NULL
  AND ta.transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS transaction_attempts_account_idx
  ON transaction_attempts(account_id, created_at DESC)
  WHERE status <> 'accepted';
