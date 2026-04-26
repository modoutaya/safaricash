-- Story 4.4 / FR23 — Migration 0027: SECURITY DEFINER record_rattrapage RPC.
--
-- Mirrors Story 4.3's record_contribution (migration 0023):
--   1. Validates auth.uid() non-null.
--   2. Validates p_daily_amount > 0, p_cycle_day in [1, 30],
--      p_days_covered in [2, 4], cycleDay + daysCovered - 1 ≤ 30.
--   3. Verifies caller owns the member.
--   4. Server-computes amount = p_daily_amount × p_days_covered (NEVER
--      trusts a client-supplied amount — defence-in-depth against tamper).
--   5. Encrypts amount via vault_encrypt.
--   6. INSERTs a transactions row with kind='rattrapage', source='online'.
--      The DB CHECK transactions_days_covered_kind_chk (migration 0026)
--      enforces days_covered ≥ 2 for kind='rattrapage'.
--   7. Returns the new transactions.id.
--
-- Triggers fire automatically (in order):
--   1. BEFORE INSERT: reject_transaction_on_closed_cycle (Story 3.4)
--      — gate closed cycles, sqlstate 23514.
--   2. (INSERT) — happens iff BEFORE didn't raise.
--   3. AFTER INSERT: audit_transactions (Story 1.2) — emits
--      transaction.committed.
--   4. AFTER INSERT: enqueue_sms_on_transaction (Story 4.3) — sms_queue
--      row queued for kind ∈ (contribution, rattrapage, advance). Body
--      remains the STUB; Story 6.1 will replace the trigger function with
--      a real template that reads kind + days_covered to render
--      "Rattrapage — N jours" (BDD line 861).
--
-- See: epics.md:847-864, _bmad-output/implementation-artifacts/4-4-record-rattrapage.md AC #8.

set check_function_bodies = off;

create or replace function public.record_rattrapage(
  p_member_id     uuid,
  p_cycle_id      uuid,
  p_daily_amount  integer,
  p_cycle_day     integer,
  p_days_covered  integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id  uuid;
  v_member_owner  uuid;
  v_amount_secret uuid;
  v_total         integer;
  v_tx_id         uuid;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
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
  -- Inclusive-day math: a rattrapage on day 28 covering 3 days covers
  -- days 28, 29, 30 = 3 days inclusive. Reject if it would extend past
  -- day 30.
  if p_cycle_day + p_days_covered - 1 > 30 then
    raise exception 'invalid_days_covered: rattrapage exceeds cycle remaining (cycle_day=% + days_covered=% > 30)',
      p_cycle_day, p_days_covered using errcode = '22000';
  end if;

  -- Ownership check — RPC is SECURITY DEFINER so the implicit RLS check
  -- on the INSERT below would bypass auth.uid; do the check explicitly.
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

  -- Server-computed total — never trust a client-supplied amount.
  v_total := p_daily_amount * p_days_covered;

  v_amount_secret := public.vault_encrypt(v_total::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source, days_covered
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'rattrapage',
    v_amount_secret, p_cycle_day, 'online', p_days_covered
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_rattrapage(uuid, uuid, integer, integer, integer) to authenticated;

comment on function public.record_rattrapage(uuid, uuid, integer, integer, integer) is
  'Atomic rattrapage insert (Story 4.4 / FR23). Server-computes amount = daily_amount × days_covered (defence-in-depth against client tampering). Encrypts via Vault, inserts kind=rattrapage row. Story 3.4 BEFORE INSERT trigger rejects on closed cycles (23514). Story 4.3 enqueue_sms_on_transaction trigger fires for kind=rattrapage. Story 6.1 will template the SMS body using kind + days_covered.';
