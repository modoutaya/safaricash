-- Story 6.8 — WhatsApp Business secondary delivery (FR29).
--
-- The LAST open story of Epic 6. WhatsApp as a secondary receipt-delivery
-- channel alongside SMS — provisioning-dependent + opt-in, with a graceful
-- no-op when WhatsApp is not provisioned.
--
-- This migration ships:
--   1. members.whatsapp_opt_in (+ _at) — the saver's WhatsApp opt-in.
--   2. sms_queue.channel ('sms' | 'whatsapp', default 'sms') — the
--      per-row delivery-channel discriminator. The default backfills every
--      existing row and keeps every existing INSERT site (enqueue_resend_*,
--      enqueue_dispute_ack, the opt_out_confirmation INSERT) unchanged.
--   3. enqueue_sms_on_transaction() — rebased. The sms_opt_out check no
--      longer early-returns the whole trigger; it gates ONLY the SMS row.
--      A second channel='whatsapp' row is enqueued when whatsapp_opt_in is
--      true. SMS gating (sms_opt_out) and WhatsApp gating (whatsapp_opt_in)
--      are INDEPENDENT — a saver opted out of SMS but into WhatsApp gets
--      only the whatsapp row.
--   4. claim_sms_queue_batch — re-derived to return `channel` so the
--      sms-worker can route a claimed row to the SMS or WhatsApp Termii
--      channel. (DROP + CREATE — the RETURNS TABLE shape changes.)
--   5. set_member_sms_opt_out — rebased on 20260517001214 (Story 10.5).
--      Its queued-row cancellation is scoped to channel='sms': an SMS
--      opt-out must not abandon a queued WhatsApp row.
--
-- The Edge worker is the PROVISIONING gate — a Postgres trigger cannot read
-- the TERMII_WHATSAPP_SENDER_ID env var, so the trigger enqueues a whatsapp
-- row whenever the saver is opted in, and the worker either sends it (when
-- provisioned) or silently abandons it (when not).
--
-- See: _bmad-output/implementation-artifacts/6-8-whatsapp-secondary-delivery.md

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. members.whatsapp_opt_in — the saver's WhatsApp opt-in (mirrors the
--    sms_opt_out / sms_opt_out_at column pattern).
-- ---------------------------------------------------------------------------

alter table public.members
  add column whatsapp_opt_in    boolean     not null default false,
  add column whatsapp_opt_in_at timestamptz null;

comment on column public.members.whatsapp_opt_in is
  'Story 6.8 / FR29 — true when the saver has opted in to WhatsApp receipt delivery. Default false; the opt-in surface is a Growth-phase story.';
comment on column public.members.whatsapp_opt_in_at is
  'Story 6.8 — timestamp the saver opted in to WhatsApp delivery (observability).';

-- ---------------------------------------------------------------------------
-- 2. sms_queue.channel — the per-row delivery-channel discriminator.
--    NOT VALID + a separate VALIDATE so ADD CONSTRAINT does not take a
--    full-table validating lock-scan (the 20260512000001 pattern).
-- ---------------------------------------------------------------------------

alter table public.sms_queue
  add column channel text not null default 'sms';

alter table public.sms_queue
  add constraint sms_queue_channel_chk
  check (channel in ('sms', 'whatsapp'))
  not valid;

alter table public.sms_queue
  validate constraint sms_queue_channel_chk;

comment on column public.sms_queue.channel is
  'Story 6.8 — delivery channel for this queue row: ''sms'' (default) or ''whatsapp''. The sms-worker routes the Termii send by this value.';

-- ---------------------------------------------------------------------------
-- 3. enqueue_sms_on_transaction() — + the WhatsApp sibling row.
--    Rebased from the current definition (20260501000002). The sms_opt_out
--    check no longer early-returns; it gates ONLY the SMS INSERT.
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_sms_on_transaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_phone           text;
  v_template_key    text;
  v_prior_count     int;
  v_sms_opt_out     boolean;
  v_whatsapp_opt_in boolean;
begin
  -- Story 7.4 — 'settlement' joins the allow-list so the settlement
  -- transaction inserted by commit_cycle_settlement fires this trigger.
  if new.kind not in ('contribution', 'rattrapage', 'advance', 'settlement') then
    return null;
  end if;

  -- Read the saver's decrypted phone + BOTH delivery preferences in one
  -- row read. Story 6.8 — sms_opt_out no longer early-returns the trigger;
  -- it gates only the SMS row below, so a saver opted out of SMS but in to
  -- WhatsApp still gets the whatsapp row.
  select coalesce(public.vault_decrypt(phone_number_encrypted), ''),
         sms_opt_out, whatsapp_opt_in
    into v_phone, v_sms_opt_out, v_whatsapp_opt_in
    from public.members
   where id = new.member_id;

  -- Skip entirely when the saver has no phone on file (cash-only path) —
  -- both SMS and WhatsApp are addressed by the E.164 phone number.
  if v_phone is null or trim(v_phone) = '' then
    return null;
  end if;

  -- Story 7.4 — kind='settlement' forces template_key='settlement'
  -- regardless of prior SMS count. Otherwise the pre-Story-7.4 picker:
  -- first_receipt for the saver's first receipt, subsequent_receipt after.
  if new.kind = 'settlement' then
    v_template_key := 'settlement';
  else
    -- Count only channel='sms' rows: the picker decides first_receipt vs
    -- subsequent_receipt by whether the saver has had an SMS receipt before
    -- (a WhatsApp-only history must not consume the saver's first SMS).
    select count(*)
      into v_prior_count
      from public.sms_queue sq
      join public.transactions t on t.id = sq.transaction_id
     where t.member_id = new.member_id
       and sq.channel = 'sms';

    v_template_key := case when v_prior_count = 0 then 'first_receipt' else 'subsequent_receipt' end;
  end if;

  -- The SMS row — unless the saver has opted out of SMS (Story 6.5).
  if not v_sms_opt_out then
    insert into public.sms_queue (
      collector_id, transaction_id, recipient_phone, body, status,
      template_key, retry_count, channel
    ) values (
      new.collector_id,
      new.id,
      v_phone,
      public.format_sms_body(v_template_key, new.id),
      'queued',
      v_template_key,
      0,
      'sms'
    );
  end if;

  -- Story 6.8 — the WhatsApp sibling row, when the saver has opted in.
  -- Independent of sms_opt_out (whatsapp_opt_in is its own consent). The
  -- worker is the provisioning gate: if WhatsApp is not provisioned it
  -- silently abandons this row.
  if v_whatsapp_opt_in then
    insert into public.sms_queue (
      collector_id, transaction_id, recipient_phone, body, status,
      template_key, retry_count, channel
    ) values (
      new.collector_id,
      new.id,
      v_phone,
      public.format_sms_body(v_template_key, new.id),
      'queued',
      v_template_key,
      0,
      'whatsapp'
    );
  end if;

  return null;
end;
$function$;

comment on function public.enqueue_sms_on_transaction() is
  'AFTER INSERT trigger on public.transactions. Enqueues a channel=sms sms_queue row (unless members.sms_opt_out) + a channel=whatsapp sibling row (when members.whatsapp_opt_in). Story 6.8: the sms_opt_out check gates only the SMS row, not the whole trigger.';

-- ---------------------------------------------------------------------------
-- 4. claim_sms_queue_batch — + the `channel` column so the worker can route.
--    The RETURNS TABLE shape changes, so DROP + CREATE.
-- ---------------------------------------------------------------------------

drop function if exists public.claim_sms_queue_batch(integer, integer);

create function public.claim_sms_queue_batch(
  p_batch_size integer default 10,
  p_claim_ttl_seconds integer default 90
)
returns table (
  id              uuid,
  collector_id    uuid,
  transaction_id  uuid,
  recipient_phone text,
  body            text,
  template_key    text,
  retry_count     integer,
  channel         text,
  age_seconds     integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  return query
  with claimed as (
    select sq.id
    from public.sms_queue sq
    left join public.transactions t on t.id = sq.transaction_id
    where sq.status = 'queued'
      and sq.abandoned_at is null
      and (sq.next_retry_at is null or sq.next_retry_at <= now())
      and (
        sq.last_attempt_at is null
        or sq.last_attempt_at < now() - (p_claim_ttl_seconds || ' seconds')::interval
      )
      and (t.id is null or t.undone_at is null)
    order by sq.next_retry_at nulls first, sq.created_at
    limit greatest(p_batch_size, 1)
    for update of sq skip locked
  )
  update public.sms_queue sq
     set last_attempt_at = now()
    from claimed
   where sq.id = claimed.id
   returning
     sq.id,
     sq.collector_id,
     sq.transaction_id,
     sq.recipient_phone,
     sq.body,
     sq.template_key,
     sq.retry_count,
     sq.channel,
     extract(epoch from (now() - sq.created_at))::int as age_seconds;
end;
$function$;

comment on function public.claim_sms_queue_batch(integer, integer) is
  'Story 6.8 — claims a batch of ready sms_queue rows (FOR UPDATE SKIP LOCKED). Returns `channel` so the sms-worker routes to the SMS or WhatsApp Termii channel. Story 6.2 claim semantics preserved.';

grant execute on function public.claim_sms_queue_batch(integer, integer) to service_role;
revoke execute on function public.claim_sms_queue_batch(integer, integer) from public;
revoke execute on function public.claim_sms_queue_batch(integer, integer) from authenticated;

-- ---------------------------------------------------------------------------
-- 5. set_member_sms_opt_out — the queued-row cancellation scoped to
--    channel='sms'. Rebased on 20260517001214 (Story 10.5); everything
--    else PRESERVED (the opt_out_confirmation enqueue, the idempotent
--    early-return, the audit emit). An SMS opt-out must not abandon a
--    queued WhatsApp row — WhatsApp delivery is governed by whatsapp_opt_in.
-- ---------------------------------------------------------------------------

create or replace function public.set_member_sms_opt_out(p_member_id uuid, p_via text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_collector_id uuid;
  v_already      boolean;
  v_phone        text;
begin
  if p_via not in ('stop_keyword', 'receipt_url', 'collector_action') then
    raise exception 'invalid_via: % is not a recognised opt-out source', p_via
      using errcode = '22000';
  end if;

  select collector_id, sms_opt_out,
         coalesce(public.vault_decrypt(phone_number_encrypted), '')
    into v_collector_id, v_already, v_phone
    from public.members
   where id = p_member_id;

  if v_collector_id is null then
    raise exception 'member_not_found: % does not exist', p_member_id
      using errcode = 'P0002';
  end if;

  -- Idempotent: already opted out → no-op (no second audit event, no
  -- second confirmation SMS).
  if v_already then
    return;
  end if;

  update public.members
     set sms_opt_out     = true,
         sms_opt_out_at  = now(),
         sms_opt_out_via = p_via,
         updated_at      = now()
   where id = p_member_id;

  -- Cancel any queued sms_queue rows for this member's transactions.
  -- Story 6.8 — scoped to channel='sms': an SMS opt-out must NOT abandon a
  -- queued WhatsApp row (WhatsApp delivery is governed by whatsapp_opt_in,
  -- a separate consent).
  update public.sms_queue sq
     set status        = 'abandoned',
         abandoned_at  = now()
    from public.transactions t
   where t.id = sq.transaction_id
     and t.member_id = p_member_id
     and sq.status = 'queued'
     and sq.channel = 'sms';

  perform public.audit_append_external(
    'sms.opt_out',
    p_member_id,
    'members',
    jsonb_build_object('via', p_via),
    v_collector_id
  );

  -- Story 10.5 — the final confirmation SMS, only on a receipt-URL opt-out.
  -- A direct INSERT (ungated), transaction_id NULL, sent once.
  if p_via = 'receipt_url' then
    if v_phone is not null and trim(v_phone) <> '' then
      insert into public.sms_queue (
        collector_id, transaction_id, recipient_phone, body, status,
        template_key, retry_count
      )
      values (
        v_collector_id,
        null,
        v_phone,
        public.format_sms_body('opt_out_confirmation', null),
        'queued',
        'opt_out_confirmation',
        0
      );
    end if;
  end if;
end;
$function$;

comment on function public.set_member_sms_opt_out(uuid, text) is
  'Story 6.5 / FR32 — flips members.sms_opt_out=true, cancels in-flight queued channel=sms SMS, emits sms.opt_out. Idempotent. Story 10.5: enqueues an opt_out_confirmation SMS on a receipt_url opt-out. Story 6.8: the cancellation is scoped to channel=sms (does not touch queued WhatsApp rows). service_role only.';

grant execute on function public.set_member_sms_opt_out(uuid, text) to service_role;
revoke execute on function public.set_member_sms_opt_out(uuid, text) from public;
revoke execute on function public.set_member_sms_opt_out(uuid, text) from authenticated;
