-- Story 6.5 — Migration 0047: set_member_sms_opt_out SECURITY DEFINER RPC.
--
-- Idempotent (no-op + no audit on repeat call). Cancels in-flight queued
-- sms_queue rows for the member's transactions (mirrors the Story 4.5
-- undo_transaction cancellation pattern). Emits the sms.opt_out audit
-- event via the 5-arg audit_append_external overload (Story 6.2).
--
-- Both opt-out paths call this RPC under service-role:
--   - Termii inbound webhook (sms-inbound Edge Function, AC #5)
--   - Receipt-URL Worker POST /r/{token}/opt-out (AC #6)
--
-- See: _bmad-output/implementation-artifacts/6-5-first-sms-consent-optout.md AC #4 / #8 / #9.

set check_function_bodies = off;

create or replace function public.set_member_sms_opt_out(
  p_member_id uuid,
  p_via       text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id uuid;
  v_already      boolean;
begin
  if p_via not in ('stop_keyword', 'receipt_url', 'collector_action') then
    raise exception 'invalid_via: % is not a recognised opt-out source', p_via
      using errcode = '22000';
  end if;

  select collector_id, sms_opt_out
    into v_collector_id, v_already
    from public.members
   where id = p_member_id;

  if v_collector_id is null then
    raise exception 'member_not_found: % does not exist', p_member_id
      using errcode = 'P0002';
  end if;

  -- Idempotent: already opted out → no-op (no second audit event).
  if v_already then
    return;
  end if;

  update public.members
     set sms_opt_out     = true,
         sms_opt_out_at  = now(),
         sms_opt_out_via = p_via,
         updated_at      = now()
   where id = p_member_id;

  -- Cancel any queued sms_queue rows for this member's transactions —
  -- the worker's drain query will skip future enqueues (the trigger
  -- short-circuits via members.sms_opt_out), but rows already inserted
  -- before the opt-out flip should not be dispatched.
  update public.sms_queue sq
     set status        = 'abandoned',
         abandoned_at  = now()
    from public.transactions t
   where t.id = sq.transaction_id
     and t.member_id = p_member_id
     and sq.status = 'queued';

  -- Audit emit via the 5-arg overload (Story 6.2). Sets
  -- request.jwt.claim.sub = p_collector_id internally and delegates
  -- to the 4-arg variant — the canonical serialiser stays in ONE place.
  perform public.audit_append_external(
    'sms.opt_out',
    p_member_id,
    'members',
    jsonb_build_object('via', p_via),
    v_collector_id
  );
end;
$$;

comment on function public.set_member_sms_opt_out(uuid, text) is
  'Story 6.5 / FR32 — flips members.sms_opt_out=true, cancels in-flight queued SMS, emits sms.opt_out audit event. Idempotent (no-op on repeat call). service_role only.';

grant execute on function public.set_member_sms_opt_out(uuid, text) to service_role;
revoke execute on function public.set_member_sms_opt_out(uuid, text) from public;
revoke execute on function public.set_member_sms_opt_out(uuid, text) from authenticated;
