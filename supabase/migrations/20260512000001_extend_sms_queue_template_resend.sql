-- Story 6.6 — Migration 0050: extend sms_queue.template_key CHECK to include 'resend'.
--
-- Story 6.1 baseline (migration 0034, 20260427000003_extend_sms_queue_for_dispatch.sql)
-- shipped the CHECK as {first_receipt, subsequent_receipt, settlement, dispute_ack}.
-- Story 6.6 introduces 'resend' for full-cycle history re-delivery (FR33).
-- Subsequent stories may extend the set further (e.g., 6.7 reuses 'resend' 1:1
-- for per-transaction re-delivery; no further CHECK extension expected at MVP).
--
-- Diff vs migration 0034: 1 CHECK line. Same byte-for-byte canonical
-- discipline as Story 6.2 / 6.5's audit-allowlist extensions.
--
-- See: _bmad-output/implementation-artifacts/6-6-resend-cycle-history.md AC #1.

set check_function_bodies = off;

-- Drop the existing CHECK (currently VALID — backfill + validate happened
-- in migration 0034). Re-add with the new allowed value.
alter table public.sms_queue
  drop constraint sms_queue_template_key_chk;

alter table public.sms_queue
  add constraint sms_queue_template_key_chk
  check (template_key in ('first_receipt', 'subsequent_receipt', 'settlement', 'dispute_ack', 'resend'))
  not valid;

-- No rows currently use 'resend' (this migration introduces it) — VALIDATE
-- is a no-op pass but enforces the invariant going forward.
alter table public.sms_queue validate constraint sms_queue_template_key_chk;

comment on constraint sms_queue_template_key_chk on public.sms_queue is
  'Story 6.1 (baseline) + Story 6.6 (resend) — allowed template_key values. Extend in subsequent stories by replacing this CHECK byte-for-byte plus one new value.';
