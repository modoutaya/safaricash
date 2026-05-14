-- Story 7.4 — Migration 0057: extend transactions_kind_enum with 'settlement'.
--
-- The settlement payout is modelled as a synthetic transaction row (kind =
-- 'settlement') inserted by the commit_cycle_settlement RPC (migration 0061).
-- The existing enqueue_sms_on_transaction trigger then picks up the row and
-- queues the settlement SMS using the existing format_sms_body('settlement',
-- tx_id) helper (migration 0029).
--
-- IMPORTANT: ALTER TYPE … ADD VALUE cannot run inside a transaction block in
-- some Postgres versions. This migration file contains ONLY the ADD VALUE
-- statement so the Supabase migration runner can execute it standalone.
--
-- See: _bmad-output/implementation-artifacts/7-4-settlement-reauth-gate.md AC #1.

alter type public.transactions_kind_enum add value if not exists 'settlement';
