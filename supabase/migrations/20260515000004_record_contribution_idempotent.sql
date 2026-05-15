-- Story 8.4 — Migration 0057: record_contribution accepts p_event_id +
-- idempotent early-return.
--
-- DROP + CREATE the function (Postgres can't change parameter defaults
-- in-place via ALTER FUNCTION — SQLSTATE 42P13. Mirrors Story 7.5's
-- get_receipt_payload migration workaround).
--
-- New signature adds p_event_id UUID DEFAULT NULL as the last parameter.
-- When provided AND a transaction with that event_id exists for the
-- same collector, RETURN the existing id WITHOUT inserting a second row.
-- This guarantees the reconciler can safely retry on any failure
-- (network glitch after insert, page reload mid-RPC, cross-tab double
-- drain) — exactly-once semantics on the server.
--
-- When p_event_id is NULL (or the lookup misses), the body falls through
-- to the original Story 4.3 logic byte-for-byte: same validation, same
-- ownership check, same encryption, same INSERT (now setting event_id
-- alongside the other columns so future retries hit the early-return).
--
-- See: _bmad-output/implementation-artifacts/8-4-reconciler-replay.md AC #2, #5.

set check_function_bodies = off;

-- Drop the existing function explicitly. The signature must match
-- exactly (parameter types only — names are ignored by DROP).
drop function if exists public.record_contribution(uuid, uuid, integer, integer);

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

  -- Story 8.4 — idempotent replay early-return. If a transaction with
  -- this event_id already exists FOR THIS COLLECTOR, return its id and
  -- skip the INSERT (and all its side-effects: audit trigger, SMS
  -- enqueue, cycle promotion). The partial UNIQUE index
  -- transactions_event_id_idx makes the lookup O(1).
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
    amount_encrypted, cycle_day, source, event_id
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'contribution',
    v_amount_secret, p_cycle_day,
    -- Story 8.4 — source flips to 'offline_reconciled' when the
    -- reconciler is calling this (it always passes p_event_id). Online
    -- path (Story 4.3) passes NULL → source='online' preserved.
    case when p_event_id is null then 'online' else 'offline_reconciled' end,
    p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_contribution(uuid, uuid, integer, integer, uuid)
  to authenticated;

comment on function public.record_contribution(uuid, uuid, integer, integer, uuid) is
  'Atomic contribution insert (Story 4.3 / FR22). Story 8.4 adds optional p_event_id for idempotent reconciler replay: when provided and a row exists with that event_id for the same collector, returns existing id WITHOUT a second insert (no duplicate audit / SMS / cycle promotion). source flips to ''offline_reconciled'' when p_event_id is provided (reconciler path) vs ''online'' (direct path).';
