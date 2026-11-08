# Financial invariants

LedgerLine uses signed integer paise: a positive entry increases an account's balance snapshot and a negative entry decreases it. For a customer account, an incoming credit is positive and an outgoing debit is negative; the complete double-entry posting always sums to zero. Customer balances must be non-negative; system clearing accounts may be negative because they represent external settlement positions.

1. **Transaction balance:** every posted transaction has `SUM(ledger_entries.amount_paise) = 0`. PostgreSQL enforces this with a deferred constraint trigger.
2. **Customer non-negative:** the derived sum for a customer account may not be below zero. PostgreSQL enforces this with a deferred constraint trigger; the transaction service must also lock accounts before checking/posting.
3. **Transfer equality:** a two-account transfer posts an equal negative source delta and positive destination delta in one database transaction. The zero-sum rule enforces equality for the complete posting.
4. **Snapshots:** the cached account snapshot is updated in the same transaction as entries and the admin/auditor reconciliation endpoint compares it against `SUM(amount_paise)`.
5. **Immutability:** posted entries and material posted transaction fields cannot be updated or deleted by database triggers and restrictive foreign keys.
6. **Idempotency:** `(user_id, key)` is unique in PostgreSQL, preventing duplicate keys from creating separate effects; the service locks/read the key and replays the original response.
7. **Atomic failure:** debit, credit, status transition, idempotency record, and audit event belong in one `BEGIN`/`COMMIT`; any error rolls the whole unit back.
8. **Reconciliation is non-corrective:** reconciliation compares snapshots and immutable ledger facts, persists findings, and records investigation notes only. A resolution action never updates/deletes entries or silently changes balances.
9. **Scheduled reconciliation uniqueness:** the worker locks the singleton due schedule row with `FOR UPDATE SKIP LOCKED` and commits the run, findings and next due time in one PostgreSQL transaction; concurrent workers cannot claim that schedule row at once.
10. **Scheduled payment uniqueness:** `(schedule_id, scheduled_for)` is unique per occurrence. Each attempt has a persisted unique idempotency key before invoking the financial engine; lease recovery reuses that key, while a new retry increments the attempt number. Every actual transfer posts only through `executeOperation` and its normal account locks/ledger constraints.

Database constraints provide structural guarantees. Transactional application logic provides lock ordering, authorization, request hashing, risk/limit checks, and safe orchestration. Neither frontend state nor an AI model authorizes payments.
