-- Story 2.7 — Migration 0018: SECURITY DEFINER restart_member_cycle RPC.
--
-- Atomic cycle restart for FR12: a member whose latest cycle is
-- 'completed' or 'settled' gets a brand-new 30-day cycle (cycle_number =
-- prev + 1, status='active'). Old cycles + their transactions are
-- preserved (additive operation — we INSERT, never UPDATE/DELETE).
--
-- Concurrency model:
--   - Per-member advisory lock (class_id 0x5AFB, distinct from the audit
--     chain's 0x5AFA) serialises restart calls against the same member.
--     Without it, two tabs could both read MAX(cycle_number) and race
--     into the unique-constraint failure path. The lock makes the failure
--     mode predictable: the second caller sees not_restartable.
--   - The lock is transaction-scoped (released on COMMIT/ROLLBACK).
--
-- Audit emission: cycle.started fires automatically via the audit_cycles
-- trigger from migration 0007 (with the actor JWT fix from migration 0017,
-- so actor lands as the collector's UUID, not 'system').
--
-- See: _bmad-output/implementation-artifacts/2-7-restart-cycle.md AC #3 + Task 0.

set check_function_bodies = off;

create or replace function public.restart_member_cycle(
  p_member_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id    uuid;
  v_member_owner    uuid;
  v_latest_status   public.cycles_status_enum;
  v_latest_number   int;
  v_new_cycle_id    uuid;
  v_today           date := current_date;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- Per-member serialisation. class_id 0x5AFB is reserved for cycle ops
  -- (the audit chain uses 0x5AFA) so SafariCash advisory locks don't collide.
  perform pg_advisory_xact_lock(0x5AFB, hashtext(p_member_id::text));

  -- Ownership check — fail fast with a stable error code if the member
  -- does not exist OR is owned by a different collector.
  select collector_id
    into v_member_owner
    from public.members
   where id = p_member_id;

  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_member_id
      using errcode = 'P0002';
  end if;

  if v_member_owner <> v_collector_id then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id
      using errcode = '28000';
  end if;

  -- Read the latest cycle for the status check + the next cycle_number.
  select status, cycle_number
    into v_latest_status, v_latest_number
    from public.cycles
   where member_id = p_member_id
   order by cycle_number desc
   limit 1;

  if v_latest_number is null then
    -- No prior cycle for this member — surface as not_restartable so the
    -- UI can show the same copy as the active/with_advance branch.
    raise exception 'not_restartable: member % has no prior cycle', p_member_id
      using errcode = '22000';
  end if;

  if v_latest_status not in ('completed', 'settled') then
    raise exception 'not_restartable: latest cycle status is %', v_latest_status
      using errcode = '22000';
  end if;

  insert into public.cycles (
    collector_id,
    member_id,
    cycle_number,
    start_date,
    end_date,
    status
  ) values (
    v_collector_id,
    p_member_id,
    v_latest_number + 1,
    v_today,
    v_today + interval '29 days',
    'active'
  )
  returning id into v_new_cycle_id;

  return v_new_cycle_id;
end;
$$;

grant execute on function public.restart_member_cycle(uuid) to authenticated;

comment on function public.restart_member_cycle(uuid) is
  'Atomic cycle restart (Story 2.7 / FR12). Inserts cycle_number = prev + 1 with status=active and a fresh 30-day window. Per-member advisory lock prevents racing INSERTs. Raises 28000 (unauthorized), 22000 (not_restartable), P0002 (not_found). Audit cycle.started fires via the migration 0007 trigger.';
