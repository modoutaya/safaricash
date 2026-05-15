-- Story 8.4 — Migration 0058: record_advance accepts p_event_id +
-- idempotent early-return.
--
-- Mirrors migration 0057 (record_contribution): DROP + CREATE with a
-- new p_event_id UUID DEFAULT NULL last parameter + idempotent
-- early-return at the top of the body.
--
-- When p_event_id resolves to an existing transaction for the caller,
-- the RPC returns its id and skips the entire body — no second insert,
-- no second audit event, no second capacity-check re-run, no second
-- cycle promotion via promote_cycle_on_advance_trigger, no second SMS
-- enqueue.
--
-- See: _bmad-output/implementation-artifacts/8-4-reconciler-replay.md AC #3.

set check_function_bodies = off;

drop function if exists public.record_advance(uuid, uuid, integer, integer, text, boolean);

create or replace function public.record_advance(
  p_member_id           uuid,
  p_cycle_id            uuid,
  p_amount              integer,
  p_cycle_day           integer,
  p_motive              text,
  p_saver_acknowledged  boolean,
  p_event_id            uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id      uuid;
  v_member_owner      uuid;
  v_daily_amount      numeric(12, 0);
  v_existing_total    numeric(12, 0);
  v_capacity          numeric(12, 0);
  v_amount_secret     uuid;
  v_motive_trimmed    text;
  v_tx_id             uuid;
  v_existing_tx_id    uuid;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- Story 8.4 — idempotent replay early-return.
  if p_event_id is not null then
    select id
      into v_existing_tx_id
      from public.transactions
     where event_id = p_event_id
       and collector_id = v_collector_id;
    if v_existing_tx_id is not null then
      return v_existing_tx_id;
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount: amount must be positive' using errcode = '22000';
  end if;
  if p_cycle_day is null or p_cycle_day < 1 or p_cycle_day > 30 then
    raise exception 'invalid_cycle_day: cycle_day must be in [1, 30]' using errcode = '22000';
  end if;

  v_motive_trimmed := trim(coalesce(p_motive, ''));
  if length(v_motive_trimmed) < 3 then
    raise exception 'invalid_motive: motive must be at least 3 characters' using errcode = '22000';
  end if;

  if p_saver_acknowledged is not true then
    raise exception 'missing_acknowledgment: saver acknowledgment required' using errcode = '22000';
  end if;

  select collector_id, daily_amount
    into v_member_owner, v_daily_amount
    from public.members
   where id = p_member_id;
  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_member_id using errcode = 'P0002';
  end if;
  if v_member_owner <> v_collector_id then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id
      using errcode = '28000';
  end if;

  select coalesce(sum(amount), 0)
    into v_existing_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id
     and kind = 'advance';

  v_capacity := v_daily_amount * 29;
  if v_existing_total + p_amount > v_capacity then
    raise exception 'over_limit: advance exceeds projected available balance (existing=% + new=% > capacity=%)',
      v_existing_total, p_amount, v_capacity using errcode = '22023';
  end if;

  v_amount_secret := public.vault_encrypt(p_amount::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source, days_covered,
    motive, saver_acknowledged, event_id
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'advance',
    v_amount_secret, p_cycle_day,
    case when p_event_id is null then 'online' else 'offline_reconciled' end,
    1,
    v_motive_trimmed, true, p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_advance(uuid, uuid, integer, integer, text, boolean, uuid)
  to authenticated;

comment on function public.record_advance(uuid, uuid, integer, integer, text, boolean, uuid) is
  'Atomic advance insert (Story 5.4 / FR24 + FR25). Story 8.4 adds optional p_event_id for idempotent reconciler replay: when provided and a row exists with that event_id for the same collector, returns existing id WITHOUT a second insert (no duplicate audit / SMS / cycle promotion / capacity recheck). source flips to ''offline_reconciled'' when p_event_id is provided.';
