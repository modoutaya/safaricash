-- Story 4.3 — Migration 0023: SECURITY DEFINER record_contribution RPC.
--
-- Atomic transaction commit for FR22 (Flow 1 online path):
--   1. Validates inputs (amount > 0, cycle_day in [1..30]).
--   2. Verifies caller owns the member (RLS-equivalent).
--   3. Encrypts amount via vault_encrypt.
--   4. INSERTs into transactions with kind='contribution', source='online'.
--   5. The Story 3.4 BEFORE INSERT trigger naturally rejects on
--      completed/settled cycles (sqlstate 23514 → PostgREST 409).
--   6. The Story 6.x AFTER INSERT trigger enqueues an SMS row in sms_queue
--      (added by migration 0024, this same story).
--   7. Audit transaction.committed event fires via the existing trigger.
--
-- Returns the new transactions.id so the client can target the row for
-- undo (DELETE within the 5-second window).
--
-- Mirrors create_member_with_cycle (migration 0014 / 0015): SECURITY
-- DEFINER + set search_path + typed sqlstate codes + GRANT EXECUTE TO
-- authenticated.

set check_function_bodies = off;

create or replace function public.record_contribution(
  p_member_id uuid,
  p_cycle_id  uuid,
  p_amount    integer,
  p_cycle_day integer
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
  v_tx_id         uuid;
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

  v_amount_secret := public.vault_encrypt(p_amount::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'contribution',
    v_amount_secret, p_cycle_day, 'online'
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_contribution(uuid, uuid, integer, integer) to authenticated;

comment on function public.record_contribution(uuid, uuid, integer, integer) is
  'Atomic contribution insert (Story 4.3 / FR22). Encrypts amount via Vault, inserts transactions row with kind=contribution + source=online. Story 3.4 BEFORE INSERT trigger rejects on closed cycles (23514). Story 6.x AFTER INSERT trigger enqueues sms_queue row. Audit transaction.committed fires via existing trigger.';
