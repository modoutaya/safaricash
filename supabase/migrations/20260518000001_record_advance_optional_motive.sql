-- Story 4.6 follow-up — make the advance motive optional.
--
-- The "Prêt Express" mockup (03-mockups.html) labels the motive field
-- "(optionnel)". This migration relaxes the two server-side rules that
-- previously forced a ≥ 3-character motive on every advance:
--
--   1. transactions_advance_motive_ack_chk CHECK constraint — drops the
--      `length(trim(motive)) >= 3` clause.
--   2. record_advance RPC — drops the invalid_motive length guard.
--
-- An advance STILL requires a non-null motive column and
-- saver_acknowledged = true: the RPC always inserts a trimmed string
-- ('' when the collector leaves the field blank) and the route always
-- passes saver_acknowledged = true. Existing advance rows (motive ≥ 3
-- chars under the old rule) satisfy the looser constraint, so the
-- DROP/ADD validates cleanly.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. Relax the table CHECK constraint.
-- ---------------------------------------------------------------------------

alter table public.transactions
  drop constraint transactions_advance_motive_ack_chk;

alter table public.transactions
  add constraint transactions_advance_motive_ack_chk
  check (
    (kind = 'advance' and motive is not null and saver_acknowledged = true)
    or
    (kind <> 'advance' and motive is null and saver_acknowledged is null)
  );

comment on column public.transactions.motive is
  'Story 5.4 / FR25 — free-text motive captured at commit (optional since the Story 4.6 Prêt Express redesign). NOT NULL for kind=advance — may be an empty string; NULL for contribution/rattrapage. Trimmed by the RPC.';

-- ---------------------------------------------------------------------------
-- 2. Recreate record_advance without the motive-length guard.
-- ---------------------------------------------------------------------------

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

  -- Story 4.6 — motive is now optional; just normalise to a trimmed
  -- string ('' when blank). No length guard.
  v_motive_trimmed := trim(coalesce(p_motive, ''));

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
