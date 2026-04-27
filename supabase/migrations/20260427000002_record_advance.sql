-- Story 5.4 / FR24 + FR25 — Migration 0033: record_advance SECURITY DEFINER RPC.
--
-- Atomic advance commit:
--   1. Validates auth.uid() non-null → 28000.
--   2. Validates p_amount > 0, p_cycle_day ∈ [1, 30],
--      length(trim(p_motive)) ≥ 3, p_saver_acknowledged = TRUE → 22000.
--   3. Verifies caller owns the member → 28000 (foreign) / P0002 (not found).
--   4. Server-side capacity check: existing-advance sum + p_amount ≤
--      dailyAmount × 29 (mirror Story 3.2 INV-3 / canAcceptAdvance).
--      Filters on undone_at IS NULL (Story 4.5 soft-undo). Over-limit
--      → 22023.
--   5. Encrypts p_amount via vault_encrypt.
--   6. INSERTs transactions row with kind='advance', source='online',
--      motive=trim(p_motive), saver_acknowledged=true, days_covered=1.
--   7. Returns the new transactions.id.
--
-- Triggers fire for free in this order:
--   - BEFORE INSERT: reject_transaction_on_closed_cycle (Story 3.4)
--     — gate closed cycles → 23514.
--   - (INSERT) — happens iff BEFORE didn't raise.
--   - AFTER INSERT: audit_emit (Story 1.2 + 3.3 + 4.5 patches) — emits
--     transaction.committed with motive + saver_acknowledged in
--     payload (BDD line 946).
--   - AFTER INSERT: enqueue_sms_on_transaction (Story 4.3) — sms_queue
--     row queued.
--   - AFTER INSERT: promote_cycle_on_advance_trigger (Story 3.3) —
--     active → with_advance flip + cycle.transitioned audit event.
--
-- See: epics.md:935-949,
-- _bmad-output/implementation-artifacts/5-4-commit-advance-transaction.md AC #2.

set check_function_bodies = off;

create or replace function public.record_advance(
  p_member_id           uuid,
  p_cycle_id            uuid,
  p_amount              integer,
  p_cycle_day           integer,
  p_motive              text,
  p_saver_acknowledged  boolean
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
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
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

  -- Ownership check.
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

  -- Server-side capacity check (defence-in-depth on Story 5.1's client
  -- gate). Reads decrypted advance amounts via transactions_decrypted
  -- (Story 4.5 view filters undone_at IS NULL automatically).
  select coalesce(sum(amount), 0)
    into v_existing_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id
     and kind = 'advance';

  v_capacity := v_daily_amount * 29;  -- CYCLE_TOTAL_DAYS - COMMISSION_DAYS = 29
  if v_existing_total + p_amount > v_capacity then
    raise exception 'over_limit: advance exceeds projected available balance (existing=% + new=% > capacity=%)',
      v_existing_total, p_amount, v_capacity using errcode = '22023';
  end if;

  v_amount_secret := public.vault_encrypt(p_amount::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source, days_covered,
    motive, saver_acknowledged
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'advance',
    v_amount_secret, p_cycle_day, 'online', 1,
    v_motive_trimmed, true
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_advance(uuid, uuid, integer, integer, text, boolean) to authenticated;

comment on function public.record_advance(uuid, uuid, integer, integer, text, boolean) is
  'Atomic advance insert (Story 5.4 / FR24 + FR25). SECURITY DEFINER. Validates ownership + amount + cycle_day + motive (≥ 3 chars) + saver_acknowledged + capacity (existing + new ≤ dailyAmount × 29). Story 3.4 BEFORE INSERT trigger rejects closed cycles (23514); Story 4.3 enqueue_sms_on_transaction trigger fires for kind=advance; Story 3.3 promote_cycle_on_advance flips active → with_advance + emits cycle.transitioned audit. Story 1.2/3.3/4.5 audit_emit captures transaction.committed with motive + saver_acknowledged in the JSON payload.';
