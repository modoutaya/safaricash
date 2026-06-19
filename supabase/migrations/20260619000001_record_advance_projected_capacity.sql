-- 2026-06-19 — record_advance: capacity = PROJECTED monthly contribution.
--
-- Pilot rule change (collector request): a saver may borrow against what
-- they are PLANNED to cotise over the whole cycle, not merely what they
-- have versed so far. The ceiling is the projected total
-- `daily_amount × cycleLength`, minus advances already taken and any
-- carry-over debt. The commission is NOT reserved — the full projection is
-- borrowable (confirmed 2026-06-19).
--
-- Pre-change capacity (migration 20260607000002, commission not borrowable):
--   v_capacity = contributedTotal
--              − LEAST(contributedTotal, daily_amount)   (commission, reserved)
--              − Σ(existing_advances)
--              − compute_opening_balance(member, cycle)
--
-- NEW capacity (mirrors TS canAcceptAdvance → computeAdvanceCapacity):
--   cycleLength = end_date − start_date + 1   (inclusive)
--   v_capacity  = daily_amount × cycleLength
--               − Σ(existing_advances)
--               − compute_opening_balance(member, cycle)
--   allowed iff new ≤ v_capacity
--
-- Worked example: daily 1 000, cycle 30 days → projected 30 000. On day 10
-- with only 10 000 versé, an advance of 20 000 is accepted (20 000 ≤ 30 000).
-- The actual contributedTotal no longer gates the advance — it remains
-- relevant only to settle() / the settlement balance, which is untouched.
--
-- Consequence: borrowing the full projection can leave the commission
-- unpaid at settlement, which then carries over as the next cycle's
-- opening_balance (compute_opening_balance). That is the accepted trade-off
-- of the "prévisionnel plein" rule.
--
-- Everything else preserved BYTE-FOR-BYTE from migration 20260607000002:
--   - idempotent replay via p_event_id (Story 8.4)
--   - input validation (amount > 0, cycle_day ∈ [1, 31], saver_acknowledged)
--   - ownership check on member, vault_encrypt, INSERT shape, error codes.

set check_function_bodies = off;

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
  v_collector_id        uuid;
  v_member_owner        uuid;
  v_daily_amount        numeric(12, 0);
  v_existing_total      numeric(12, 0);
  v_opening_balance     numeric(12, 0);
  v_cycle_length        integer;
  v_projected_total     numeric(12, 0);
  v_capacity            numeric(12, 0);
  v_amount_secret       uuid;
  v_motive_trimmed      text;
  v_tx_id               uuid;
  v_existing_tx_id      uuid;
  v_cycle_start         date;
  v_cycle_end           date;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- Story 8.4 — idempotent replay early-return.
  if p_event_id is not null then
    select id into v_existing_tx_id
      from public.transactions
     where event_id = p_event_id and collector_id = v_collector_id;
    if v_existing_tx_id is not null then
      return v_existing_tx_id;
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount: amount must be positive' using errcode = '22000';
  end if;
  if p_cycle_day is null or p_cycle_day < 1 or p_cycle_day > 31 then
    raise exception 'invalid_cycle_day: cycle_day must be in [1, 31]' using errcode = '22000';
  end if;

  v_motive_trimmed := trim(coalesce(p_motive, ''));

  if p_saver_acknowledged is not true then
    raise exception 'missing_acknowledgment: saver acknowledgment required' using errcode = '22000';
  end if;

  select collector_id, daily_amount into v_member_owner, v_daily_amount
    from public.members where id = p_member_id;
  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_member_id using errcode = 'P0002';
  end if;
  if v_member_owner <> v_collector_id then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id using errcode = '28000';
  end if;

  select c.start_date, c.end_date into v_cycle_start, v_cycle_end
    from public.cycles c where c.id = p_cycle_id;
  if v_cycle_start is null then
    raise exception 'not_found: cycle % does not exist', p_cycle_id using errcode = 'P0002';
  end if;

  -- 2026-06-19 — capacity = projected total − Σ(existing) − opening.
  select coalesce(sum(amount), 0) into v_existing_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id and kind = 'advance';

  -- cycleLength is the inclusive day count; mirrors TS cycleLengthDays.
  v_cycle_length := (v_cycle_end - v_cycle_start) + 1;
  v_projected_total := v_daily_amount * v_cycle_length;
  v_opening_balance := public.compute_opening_balance(p_member_id, p_cycle_id);
  v_capacity := v_projected_total - v_existing_total - v_opening_balance;

  if p_amount > v_capacity then
    raise exception 'over_limit: advance exceeds projected capacity (projected=% (daily=% × cycle_length=%) − existing_advances=% − opening_balance=% = capacity=%; new=%)',
      v_projected_total, v_daily_amount, v_cycle_length, v_existing_total, v_opening_balance, v_capacity, p_amount
      using errcode = '22023';
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
    1, v_motive_trimmed, true, p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_advance(uuid, uuid, integer, integer, text, boolean, uuid) to authenticated;

comment on function public.record_advance(uuid, uuid, integer, integer, text, boolean, uuid) is
  '2026-06-19: atomic advance insert. Capacity = daily_amount × cycleLength (projected monthly contribution, commission NOT reserved) − Σ(existing_advances) − compute_opening_balance(member, cycle). Mirrors TS canAcceptAdvance → computeAdvanceCapacity. A saver may borrow against the planned cycle total, not merely what has been versed so far.';
