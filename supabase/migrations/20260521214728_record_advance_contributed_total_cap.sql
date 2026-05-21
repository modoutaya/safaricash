-- Story 12.5 PR B — record_advance capacity uses actual contributedTotal.
--
-- The pilot-confirmed model (cotisation libre): the collector NEVER
-- advances more than what's been versed so far. No lending against the
-- daily-amount "contract" (which doesn't exist under this model).
--
--   NEW capacity = contributedTotal − Σ(existing_advances)
--   allowed iff Σ(existing) + new ≤ contributedTotal
--
-- where contributedTotal = Σ kind ∈ {contribution, rattrapage} amounts
-- booked in this cycle (undone excluded).
--
-- PRE-12.5 capacity (replaced):
--   OLD capacity = dailyAmount × (cycleLength − 1) − opening_balance
--
-- Mirrors TS canAcceptAdvance — no NFR-R3 cross-check on advance writes
-- (the client never passes an expected-capacity), but TS+SQL must agree
-- so the UI never offers an advance the server rejects.
--
-- Latest pre-12.5 version: migration 20260521084835 (Story 12.3 Phase A).
-- Other behaviour preserved BYTE-FOR-BYTE:
--   - idempotent replay via p_event_id (Story 8.4)
--   - input validation (amount > 0, cycle_day ∈ [1, 31], saver_acknowledged)
--   - ownership check on member (collector_id = auth.uid())
--   - vault_encrypt of amount, INSERT shape, error codes, return type.

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
  v_daily_amount        numeric(12, 0);  -- kept for backward shape; UI hint only.
  v_existing_total      numeric(12, 0);
  v_contributed_total   numeric(12, 0);
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

  -- Story 12.5 PR B — capacity bound by ACTUAL contributedTotal of this cycle.
  select coalesce(sum(amount), 0) into v_contributed_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id and kind in ('contribution', 'rattrapage');

  select coalesce(sum(amount), 0) into v_existing_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id and kind = 'advance';

  v_capacity := v_contributed_total - v_existing_total;

  if p_amount > v_capacity then
    raise exception 'over_limit: advance exceeds available cash (contributed=% − existing_advances=% = capacity=%; new=%)',
      v_contributed_total, v_existing_total, v_capacity, p_amount using errcode = '22023';
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
  'Story 12.5 PR B: atomic advance insert with NEW capacity formula — cap = contributedTotal − Σ(existing_advances). The pre-12.5 cap was daily × contribDays − opening_balance which over-credited savers who hadn''t versed every day yet. Mirrors TS canAcceptAdvance.';
