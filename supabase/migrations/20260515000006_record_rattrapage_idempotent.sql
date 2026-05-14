-- Story 8.4 — Migration 0059: record_rattrapage accepts p_event_id +
-- idempotent early-return.
--
-- Mirrors migrations 0057 / 0058 (record_contribution, record_advance):
-- DROP + CREATE with a new p_event_id UUID DEFAULT NULL last parameter
-- + idempotent early-return at the top of the body.
--
-- When p_event_id resolves to an existing transaction for the caller,
-- the RPC returns its id and skips the entire body — no second insert,
-- no second audit event, no second days-covered validation, no second
-- SMS enqueue.
--
-- See: _bmad-output/implementation-artifacts/8-4-reconciler-replay.md AC #4.

set check_function_bodies = off;

drop function if exists public.record_rattrapage(uuid, uuid, integer, integer, integer);

create or replace function public.record_rattrapage(
  p_member_id     uuid,
  p_cycle_id      uuid,
  p_daily_amount  integer,
  p_cycle_day     integer,
  p_days_covered  integer,
  p_event_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id    uuid;
  v_member_owner    uuid;
  v_amount_secret   uuid;
  v_total           integer;
  v_tx_id           uuid;
  v_existing_tx_id  uuid;
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

  if p_daily_amount is null or p_daily_amount <= 0 then
    raise exception 'invalid_amount: daily_amount must be positive' using errcode = '22000';
  end if;
  if p_cycle_day is null or p_cycle_day < 1 or p_cycle_day > 30 then
    raise exception 'invalid_cycle_day: cycle_day must be in [1, 30]' using errcode = '22000';
  end if;
  if p_days_covered is null or p_days_covered < 2 or p_days_covered > 4 then
    raise exception 'invalid_days_covered: days_covered must be in [2, 4]' using errcode = '22000';
  end if;
  if p_cycle_day + p_days_covered - 1 > 30 then
    raise exception 'invalid_days_covered: rattrapage exceeds cycle remaining (cycle_day=% + days_covered=% > 30)',
      p_cycle_day, p_days_covered using errcode = '22000';
  end if;

  select collector_id
    into v_member_owner
    from public.members
   where id = p_member_id;
  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_member_id using errcode = 'P0002';
  end if;
  if v_member_owner <> v_collector_id then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id
      using errcode = '28000';
  end if;

  v_total := p_daily_amount * p_days_covered;
  v_amount_secret := public.vault_encrypt(v_total::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source, days_covered, event_id
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'rattrapage',
    v_amount_secret, p_cycle_day,
    case when p_event_id is null then 'online' else 'offline_reconciled' end,
    p_days_covered, p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_rattrapage(uuid, uuid, integer, integer, integer, uuid)
  to authenticated;

comment on function public.record_rattrapage(uuid, uuid, integer, integer, integer, uuid) is
  'Atomic rattrapage insert (Story 4.4 / FR23). Story 8.4 adds optional p_event_id for idempotent reconciler replay: when provided and a row exists with that event_id for the same collector, returns existing id WITHOUT a second insert. source flips to ''offline_reconciled'' when p_event_id is provided.';
