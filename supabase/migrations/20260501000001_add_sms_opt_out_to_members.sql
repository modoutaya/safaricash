-- Story 6.5 — Migration 0044: members.sms_opt_out + observability columns.
--
-- New columns:
--   sms_opt_out      bool NOT NULL DEFAULT false — the gate Story 6.5's
--                     trigger replacement (migration 0045) reads.
--   sms_opt_out_at   timestamptz NULL              — observability.
--   sms_opt_out_via  text NULL CHECK (...)         — analytics.
--
-- See: _bmad-output/implementation-artifacts/6-5-first-sms-consent-optout.md AC #1.

set check_function_bodies = off;

alter table public.members
  add column sms_opt_out     boolean       not null default false,
  add column sms_opt_out_at  timestamptz   null,
  add column sms_opt_out_via text          null
    check (sms_opt_out_via is null or sms_opt_out_via in ('stop_keyword', 'receipt_url', 'collector_action'));

comment on column public.members.sms_opt_out is
  'Story 6.5 / FR32 — true once the saver has explicitly opted out. The enqueue_sms_on_transaction trigger short-circuits when this is true.';
comment on column public.members.sms_opt_out_at is
  'Story 6.5 — set when sms_opt_out flips false → true (via set_member_sms_opt_out RPC).';
comment on column public.members.sms_opt_out_via is
  'Story 6.5 — analytics column. ''stop_keyword'' = Termii inbound webhook, ''receipt_url'' = Worker POST /r/{token}/opt-out, ''collector_action'' = future collector-app surface.';

-- Partial index — the trigger's hot path is a per-transaction lookup
-- (`WHERE id = NEW.member_id AND sms_opt_out = true`). Partial keeps
-- the index tiny (only opted-out rows, a small fraction of members).
create index idx_members_sms_opt_out
  on public.members (id)
  where sms_opt_out = true;

comment on index public.idx_members_sms_opt_out is
  'Story 6.5 — partial index for the trigger short-circuit lookup; only contains opted-out members.';
