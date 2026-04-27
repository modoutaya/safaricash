-- Story 6.1 / FR27 — Migration 0034: extend sms_queue for durable dispatch.
--
-- Adds 4 columns + a partial drain index for Story 6.2's worker:
--   - template_key       — names the SMS template Story 6.3 will render
--                          (the body field stays as a STUB until 6.2/6.3
--                          land at the worker layer).
--   - retry_count        — replaces the legacy `attempts` column (kept
--                          for backwards compat; deprecated, future
--                          cleanup migration will drop it).
--   - next_retry_at      — Story 6.2 sets this on each Termii failure.
--   - abandoned_at       — Story 6.2 sets this after 24h continuous
--                          failure.
--
-- The partial drain index optimises the Story 6.2 worker query
--   WHERE status='queued' AND abandoned_at IS NULL
--   AND (next_retry_at IS NULL OR next_retry_at <= now())
--   ORDER BY next_retry_at NULLS FIRST, created_at
--
-- See: epics.md:961-967, _bmad-output/implementation-artifacts/6-1-sms-dispatch-edge-function.md AC #1 #2 #3.

set check_function_bodies = off;

alter table public.sms_queue
  add column template_key text null,
  add column retry_count int not null default 0 check (retry_count >= 0),
  add column next_retry_at timestamptz null,
  add column abandoned_at timestamptz null;

comment on column public.sms_queue.template_key is
  'Story 6.1 / FR27 — names the SMS template Story 6.3 will render. NOT NULL after backfill (this migration). CHECK-constrained to first_receipt / subsequent_receipt / settlement / dispute_ack.';

comment on column public.sms_queue.retry_count is
  'Story 6.1 — Termii dispatch retry counter. Story 6.2 increments on each failure. Replaces the legacy `attempts` column (deprecated; future cleanup migration will drop it).';

comment on column public.sms_queue.next_retry_at is
  'Story 6.1 — Story 6.2 sets this to schedule the exponential-backoff retry (10s → max 10min). NULL = ready to drain immediately.';

comment on column public.sms_queue.abandoned_at is
  'Story 6.1 — Story 6.2 sets this when the row is given up on (24h continuous failure per architecture.md:643). NULL = still active.';

-- Add CHECK constraint NOT VALID first so existing STUB rows don't fail.
alter table public.sms_queue
  add constraint sms_queue_template_key_chk
  check (template_key in ('first_receipt', 'subsequent_receipt', 'settlement', 'dispute_ack'))
  not valid;

-- Backfill existing rows. Conservative choice: 'first_receipt' includes
-- the consent disclosure (safer if the row was inserted before any
-- explicit consent flow). Pre-prod local dev only; CI starts clean.
update public.sms_queue set template_key = 'first_receipt' where template_key is null;

-- Now safe to enforce NOT NULL + validate the CHECK.
alter table public.sms_queue alter column template_key set not null;
alter table public.sms_queue validate constraint sms_queue_template_key_chk;

-- Partial drain index for Story 6.2's worker.
create index idx_sms_queue_drain_ready
  on public.sms_queue (next_retry_at nulls first, created_at)
  where status = 'queued' and abandoned_at is null;

comment on index public.idx_sms_queue_drain_ready is
  'Story 6.1 — partial index supporting Story 6.2 worker drain query. NULLS FIRST ordering picks fresh rows before previously-failed rows.';
