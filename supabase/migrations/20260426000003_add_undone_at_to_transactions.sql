-- Story 4.5 / FR22 support — Migration 0028: soft-undo schema.
--
-- Rewrites Story 4.3's hard-DELETE undo path to a soft-undo pattern that
-- preserves the original transaction row, marks it undone, and lets the
-- audit chain reference it forever. NFR-S6 hash-chain integrity demands
-- that audit_log.entity_id continue to resolve — soft-undo + view-filter
-- preserves that contract; hard-DELETE breaks it.
--
-- 1. transactions.undone_at — set to now() by undo_transaction RPC.
--    NULL means "live"; non-NULL means "undone, filtered from
--    transactions_decrypted view".
-- 2. sms_queue.transaction_id FK flipped from ON DELETE CASCADE to
--    ON DELETE SET NULL. The cascade was needed when undo = DELETE; soft-
--    undo never deletes, so the cascade is dead code. SET NULL preserves
--    semantically meaningful behaviour for any future direct DELETE
--    (forensic SMS rows survive with transaction_id=NULL instead of
--    silently disappearing).
--
-- A separate `undone_event_id` column was considered for traceability
-- (FK-style pointer to the audit_log row of the transaction.undone
-- event) but rejected: the audit row already references the transaction
-- via entity_id, and writing back the FK would require a second UPDATE
-- which would re-fire the audit trigger and emit a spurious
-- `transaction.updated` event. Trace via `entity_id + event_type`.
--
-- See: epics.md:866-882 (Story 4.5 BDD),
-- _bmad-output/implementation-artifacts/4-5-undo-transaction-window.md AC #1 #2.

set check_function_bodies = off;

alter table public.transactions
  add column undone_at timestamptz null;

comment on column public.transactions.undone_at is
  'Story 4.5 — set to now() by undo_transaction RPC; NULL = live row. transactions_decrypted view filters out non-NULL.';

-- Flip sms_queue.transaction_id FK behaviour.
alter table public.sms_queue
  drop constraint if exists sms_queue_transaction_id_fkey;

alter table public.sms_queue
  add constraint sms_queue_transaction_id_fkey
  foreign key (transaction_id)
  references public.transactions(id)
  on delete set null;
