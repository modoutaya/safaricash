-- Story 12.5 PR D — compute_opening_balance recurses from the PREVIOUS
-- cycle's CURRENT balance, not its theoretical projection.
--
-- Pre-PR-D formula (Phase A):
--   v_prev_balance = v_daily_amount × v_prev_contrib_days
--                  − v_prev_advances − v_prev_opening
-- assumed every saver verses daily × contribDays exactly. Story 12.5 PR A
-- corrected settle() / commit_cycle_settlement. PR B corrected the
-- advance capacity. PR C corrected the SMS / receipt projected line.
-- PR D now closes the last gap — the carry-over helper.
--
-- NEW formula:
--   v_prev_balance = v_prev_contributed_total
--                  − v_daily_amount   (commission)
--                  − v_prev_advances
--                  − v_prev_opening
--   opening_balance(current) = max(0, −v_prev_balance)
--
-- That's identical to settle() applied to the previous cycle —
-- opening_balance IS the unpaid residual that didn't fit in the
-- previous payout.
--
-- Mirrors TS computeOpeningBalance — cross-checked by the Deno
-- compute-opening-balance.contract.test.ts.

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

  -- Story 12.5 PR D — currentBalance formula on the previous cycle.
  v_prev_balance := v_prev_contributed
                    - v_daily_amount
                    - v_prev_advances
                    - v_prev_opening;

  if v_prev_balance >= 0 then
    return 0;
  end if;
  return -v_prev_balance;
end;
$$;

comment on function public.compute_opening_balance(uuid, uuid) is
  'Story 12.5 PR D: recursive carry-over of unpaid debt from the previous unsettled cycle. Returns the debt in F CFA (≥ 0). NEW formula: prev_balance = prev_contributedTotal − daily − prev_advances − prev_opening — mirrors the cotisation-libre settle() applied to the previous cycle. STABLE + SECURITY DEFINER with explicit ownership check. Mirrors TS computeOpeningBalance — cross-checked by compute-opening-balance.contract.test.ts.';

grant execute on function public.compute_opening_balance(uuid, uuid) to authenticated, service_role;
revoke execute on function public.compute_opening_balance(uuid, uuid) from public;
