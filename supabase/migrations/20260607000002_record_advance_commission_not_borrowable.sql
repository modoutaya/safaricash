-- 2026-06-07 — record_advance: the COMMISSION IS NOT BORROWABLE.
--
-- Pilot rule confirmed by the collectors: a saver can never borrow into the
-- part of their contribution that becomes the collector's commission, nor
-- more than what they have actually versed. The borrowable ceiling is
-- exactly what would be reversible to the saver if settled now.
--
-- Pre-change capacity (migration 20260521214728, Story 12.5 PR B):
--   v_capacity = contributedTotal − Σ(existing_advances)
-- That let the commission "leak" out as an advance, then reappear as a
-- phantom carry-over ("Report") on the next cycle via compute_opening_balance.
--
-- NEW capacity (mirrors TS canAcceptAdvance → computeCurrentBalance):
--   v_capacity = contributedTotal
--              − LEAST(contributedTotal, daily_amount)   (commission, reserved)
--              − Σ(existing_advances)
--              − compute_opening_balance(member, cycle)  (carry-over debt)
--   allowed iff new ≤ v_capacity
--
-- Consequence: until the saver has cotisé ≥ one full day, the whole
-- contribution is reserved for the commission and capacity is 0. Because
-- advances can therefore never exceed (contributed − commission − opening),
-- a settlement balance never goes negative on advances alone — which is
-- why a real carry-over can no longer arise from borrowing.
--
-- Everything else preserved BYTE-FOR-BYTE from migration 20260521214728:
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
  v_contributed_total   numeric(12, 0);
  v_commission          numeric(12, 0);
  v_opening_balance     numeric(12, 0);
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

  -- Cycle existence check (kept from Phase A for the error-path coverage).
  select c.start_date, c.end_date into v_cycle_start, v_cycle_end
    from public.cycles c where c.id = p_cycle_id;
  if v_cycle_start is null then
    raise exception 'not_found: cycle % does not exist', p_cycle_id using errcode = 'P0002';
  end if;

  -- 2026-06-07 — capacity = contributedTotal − commission − Σ(existing) − opening.
  select coalesce(sum(amount), 0) into v_contributed_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id and kind in ('contribution', 'rattrapage');

  select coalesce(sum(amount), 0) into v_existing_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id and kind = 'advance';

  -- Commission is NOT borrowable. LEAST = min(contributed, daily).
  v_commission := least(v_contributed_total, v_daily_amount);
  v_opening_balance := public.compute_opening_balance(p_member_id, p_cycle_id);
  v_capacity := v_contributed_total - v_commission - v_existing_total - v_opening_balance;

  if p_amount > v_capacity then
    raise exception 'over_limit: advance exceeds available cash (contributed=% − commission=% − existing_advances=% − opening_balance=% = capacity=%; new=%)',
      v_contributed_total, v_commission, v_existing_total, v_opening_balance, v_capacity, p_amount
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
  '2026-06-07: atomic advance insert. Capacity = contributedTotal − LEAST(contributedTotal, daily) (commission, NOT borrowable) − Σ(existing_advances) − compute_opening_balance(member, cycle). Mirrors TS canAcceptAdvance → computeCurrentBalance. The commission can never be lent, so advances never push the settlement balance negative.';
