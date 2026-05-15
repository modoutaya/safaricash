-- Story 8.4 — Migration 0061: fix `source` column cast in 3 record-* RPCs.
--
-- Migrations 0057/0058/0059 introduced `CASE WHEN p_event_id IS NULL THEN
-- 'online' ELSE 'offline_reconciled' END` for the `source` column INSERT.
-- The CASE expression produces `text`. The `source` column is the enum
-- `transactions_source_enum`. Postgres AUTO-COERCES string literals on
-- INSERT into enum columns, but NOT the result of a CASE expression —
-- the actual INSERT fails with SQLSTATE 42804 (datatype_mismatch):
--
--   column "source" is of type transactions_source_enum but expression
--   is of type text
--
-- The bug surfaced in Playwright E2E (5 tests failed on PR #70 CI):
-- flow-1-record-contribution, flow-1-record-rattrapage, flow-2-advance,
-- flow-1-offline-replay, receipt-url-worker (all use the record-*
-- RPCs to seed transactions).
--
-- Local pre-push gates (typecheck / lint / vitest / build) didn't catch
-- this because the bug is on the Postgres side: the migration compiles
-- AND auto-coerces string literals work in `source = 'online'` style
-- (Stories 4.3-5.4 baseline), but the new CASE expression doesn't.
--
-- Lesson saved to memory `feedback_migration_rpc_run_test_edge.md`:
-- when a story touches RPC bodies + migrations, ALWAYS run
-- `npm run test:edge` locally before push.
--
-- Fix: cast the CASE expression result to the enum.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- record_contribution
-- ---------------------------------------------------------------------------

drop function if exists public.record_contribution(uuid, uuid, integer, integer, uuid);

create or replace function public.record_contribution(
  p_member_id uuid,
  p_cycle_id  uuid,
  p_amount    integer,
  p_cycle_day integer,
  p_event_id  uuid default null
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
  v_tx_id           uuid;
  v_existing_tx_id  uuid;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

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

  v_amount_secret := public.vault_encrypt(p_amount::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source, event_id
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'contribution',
    v_amount_secret, p_cycle_day,
    -- 0061 fix: explicit cast on the CASE result.
    (case when p_event_id is null then 'online' else 'offline_reconciled' end)::transactions_source_enum,
    p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_contribution(uuid, uuid, integer, integer, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- record_advance
-- ---------------------------------------------------------------------------

drop function if exists public.record_advance(uuid, uuid, integer, integer, text, boolean, uuid);

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
    -- 0061 fix.
    (case when p_event_id is null then 'online' else 'offline_reconciled' end)::transactions_source_enum,
    1,
    v_motive_trimmed, true, p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_advance(uuid, uuid, integer, integer, text, boolean, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- record_rattrapage
-- ---------------------------------------------------------------------------

drop function if exists public.record_rattrapage(uuid, uuid, integer, integer, integer, uuid);

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
    -- 0061 fix.
    (case when p_event_id is null then 'online' else 'offline_reconciled' end)::transactions_source_enum,
    p_days_covered, p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_rattrapage(uuid, uuid, integer, integer, integer, uuid)
  to authenticated;
