-- 2026-06-07 — compute_opening_balance caps the commission at
-- LEAST(prev_contributed, daily_amount), closing the last gap left by the
-- 2026-05-24 "no cotisation ⇒ no commission" change.
--
-- The May-24 migration (commission_capped_by_contributed) swept
-- commit_cycle_settlement, format_sms_body and the projected_balance view
-- to use LEAST(contributed, daily) — but it MISSED compute_opening_balance,
-- which kept subtracting the full daily_amount. Result: a member who had
-- not versé anything in the previous (unsettled) cycle still carried a
-- full day of commission as a phantom "Report" into the next cycle, even
-- though settle() correctly paid them 0 and never billed that commission.
--
-- Pre-change formula (migration 20260521233102):
--   v_prev_balance = v_prev_contributed − v_daily_amount
--                  − v_prev_advances − v_prev_opening
--
-- NEW formula:
--   v_prev_balance = v_prev_contributed − LEAST(v_prev_contributed, v_daily_amount)
--                  − v_prev_advances − v_prev_opening
--   opening_balance(current) = max(0, −v_prev_balance)
--
-- Now byte-for-byte identical to settle() / computeCurrentBalance applied
-- to the previous cycle. Mirrors TS computeOpeningBalance (Math.min) —
-- cross-checked by compute-opening-balance.contract.test.ts (NFR-R3).
--
-- Behaviour unchanged whenever prev_contributed ≥ daily_amount (LEAST =
-- daily), i.e. every existing contract-test fixture (contrib 15 000 ≫
-- daily 500) is unaffected. Only zero / sub-day cotisation cycles change.

set check_function_bodies = off;

create or replace function public.compute_opening_balance(
  p_member_id  uuid,
  p_cycle_id   uuid
) returns bigint
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller             uuid;
  v_member_owner       uuid;
  v_daily_amount       bigint;
  v_cycle_number       integer;
  v_prev               record;
  v_prev_advances      bigint;
  v_prev_contributed   bigint;
  v_prev_opening       bigint;
  v_prev_balance       bigint;
begin
  -- Ownership gate. service_role bypasses (auth.uid() returns null for
  -- service-role JWTs; we accept that for backend callers like sms-worker
  -- which need to read the math layer without an auth context).
  v_caller := auth.uid();

  select collector_id, daily_amount::bigint
    into v_member_owner, v_daily_amount
    from public.members
   where id = p_member_id;
  if v_member_owner is null then
    return 0;
  end if;
  if v_caller is not null and v_member_owner <> v_caller then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id
      using errcode = '28000';
  end if;

  -- Find the current cycle's cycle_number.
  select cycle_number into v_cycle_number
    from public.cycles
   where id = p_cycle_id and member_id = p_member_id;
  if v_cycle_number is null or v_cycle_number <= 1 then
    return 0;
  end if;

  -- Previous cycle = same member, cycle_number − 1.
  select id, status
    into v_prev
    from public.cycles
   where member_id = p_member_id and cycle_number = v_cycle_number - 1;
  if v_prev.id is null then
    return 0;
  end if;
  if v_prev.status = 'settled' then
    return 0;
  end if;

  -- Sum previous cycle's advances (excluding soft-undone).
  select coalesce(
           sum(nullif(public.vault_decrypt(amount_encrypted), '')::numeric(12, 0)),
           0
         )::bigint
    into v_prev_advances
    from public.transactions
   where cycle_id = v_prev.id
     and kind = 'advance'
     and undone_at is null;

  -- Story 12.5 PR D — Σ contributions + rattrapage of previous cycle.
  select coalesce(
           sum(nullif(public.vault_decrypt(amount_encrypted), '')::numeric(12, 0)),
           0
         )::bigint
    into v_prev_contributed
    from public.transactions
   where cycle_id = v_prev.id
     and kind in ('contribution', 'rattrapage')
     and undone_at is null;

  -- Recurse: prev's own opening_balance carries forward from ITS predecessor.
  v_prev_opening := public.compute_opening_balance(p_member_id, v_prev.id);

  -- 2026-06-07 — commission capped at LEAST(prev_contributed, daily).
  -- LEAST is PostgreSQL's min(). Mirrors TS Math.min(prevContributed,
  -- dailyAmount). "No cotisation ⇒ no commission" — a zero/sub-day cycle
  -- carries no phantom commission debt.
  v_prev_balance := v_prev_contributed
                    - least(v_prev_contributed, v_daily_amount)
                    - v_prev_advances
                    - v_prev_opening;

  if v_prev_balance >= 0 then
    return 0;
  end if;
  return -v_prev_balance;
end;
$$;

comment on function public.compute_opening_balance(uuid, uuid) is
  '2026-06-07: recursive carry-over of unpaid debt from the previous unsettled cycle. Returns the debt in F CFA (≥ 0). prev_balance = prev_contributedTotal − LEAST(prev_contributedTotal, daily) − prev_advances − prev_opening — commission capped (no cotisation ⇒ no commission), mirrors the cotisation-libre settle() applied to the previous cycle. STABLE + SECURITY DEFINER with explicit ownership check. Mirrors TS computeOpeningBalance — cross-checked by compute-opening-balance.contract.test.ts.';

grant execute on function public.compute_opening_balance(uuid, uuid) to authenticated, service_role;
revoke execute on function public.compute_opening_balance(uuid, uuid) from public;
