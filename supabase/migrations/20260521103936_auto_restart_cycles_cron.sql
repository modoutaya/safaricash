-- Story 12.3 Phase B — auto-restart every active member's cycle on the 1st
-- of each month + pg_cron schedule.
--
-- Spec: _bmad-output/implementation-artifacts/12-3-cycle-auto-restart-with-carryover.md AC #9 + #10.
--
-- Builds on Phase A (migration 20260521084835): opening_balance is computed
-- dynamically from the previous unsettled cycle, so we don't store it on
-- the new cycle. We just close the previous (mark 'completed' if still
-- 'active' / 'with_advance') and open the next.
--
-- The cron job runs at 00:00 UTC on the 1st of each month. Senegal is
-- UTC+0 → 00:00 UTC = 00:00 local. pg_cron is already enabled by
-- migration 20260428000002 (sms-worker schedule); this migration only
-- adds a new named job.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. restart_active_cycles_for_month — atomic batch restart RPC.
--
-- Iterates every member with status='active' (Q4 — paused/deleted skipped).
-- For each, closes the latest cycle ('completed') if still open, then
-- inserts the next cycle starting p_today, end derived via derive_cycle_bounds
-- (Story 11.5 cap-30). cycle_number monotonically increments.
--
-- Idempotency (AC #9): a second invocation on the same date is a no-op
-- per member that already has a cycle at start_date = p_today.
--
-- SECURITY DEFINER + service_role-only grant: callable by the pg_cron
-- job below (which runs as the schedule owner) and by service-role
-- tools (manual ops, smoke-tests). Not exposed to authenticated users —
-- collectors use the per-member restart_member_cycle RPC.
--
-- Returns counters for observability:
--   members_processed  — number of members with status='active' scanned
--   cycles_restarted   — number of new cycles inserted (= 0 on re-run)
--   cycles_skipped     — already-restarted or defensively-skipped members
-- ---------------------------------------------------------------------------

create or replace function public.restart_active_cycles_for_month(p_today date)
returns table (
  members_processed  int,
  cycles_restarted   int,
  cycles_skipped     int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member              record;
  v_latest              record;
  v_new_start           date;
  v_new_end             date;
  v_members_processed   int := 0;
  v_cycles_restarted    int := 0;
  v_cycles_skipped      int := 0;
begin
  -- Derive the new-cycle bounds once (same for every member — the cron
  -- passes the 1st of the month; derive_cycle_bounds returns a full
  -- calendar-month cap-30 cycle).
  select b.start_date, b.end_date into v_new_start, v_new_end
    from public.derive_cycle_bounds(p_today) as b;

  for v_member in
    select id, collector_id
      from public.members
     where status = 'active'
  loop
    v_members_processed := v_members_processed + 1;

    -- Idempotency: if this member already has a cycle starting on
    -- v_new_start, the cron has already restarted them today. Skip.
    if exists (
      select 1 from public.cycles
       where member_id = v_member.id and start_date = v_new_start
    ) then
      v_cycles_skipped := v_cycles_skipped + 1;
      continue;
    end if;

    -- Find the member's most recent cycle (cycle_number desc).
    select id, status, cycle_number
      into v_latest
      from public.cycles
     where member_id = v_member.id
     order by cycle_number desc
     limit 1;

    -- Defensive: status='active' members are created with a bootstrap
    -- cycle via create_member_with_cycle, so this branch should be
    -- unreachable. Skip if it ever isn't.
    if v_latest.id is null then
      v_cycles_skipped := v_cycles_skipped + 1;
      continue;
    end if;

    -- Close the previous cycle if it's still open. 'completed' and
    -- 'settled' stay as-is (settlement is a separate manual flow —
    -- per the decisions locked 2026-05-20).
    if v_latest.status in ('active', 'with_advance') then
      update public.cycles
         set status = 'completed', updated_at = now()
       where id = v_latest.id;
    end if;

    -- Open the next cycle. cycle_number monotonic; opening_balance is
    -- NOT stored (Q1 Path A — derived dynamically by compute_opening_balance
    -- from the previous unsettled cycle's debt).
    insert into public.cycles (
      collector_id, member_id, cycle_number, start_date, end_date, status
    ) values (
      v_member.collector_id,
      v_member.id,
      v_latest.cycle_number + 1,
      v_new_start,
      v_new_end,
      'active'
    );
    v_cycles_restarted := v_cycles_restarted + 1;
  end loop;

  return query select v_members_processed, v_cycles_restarted, v_cycles_skipped;
end;
$$;

comment on function public.restart_active_cycles_for_month(date) is
  'Story 12.3 Phase B — atomic batch restart of every member.status=''active'' cycle on a target date (passed by the pg_cron job below as current_date on the 1st of each month). Marks the previous cycle ''completed'' (if still ''active''/''with_advance'') and opens a fresh one with cap-30 month-aligned bounds. Idempotent via member_id + start_date check. opening_balance is NOT stored — Phase A''s compute_opening_balance derives it dynamically.';

grant execute on function public.restart_active_cycles_for_month(date) to service_role;
revoke execute on function public.restart_active_cycles_for_month(date) from public;
revoke execute on function public.restart_active_cycles_for_month(date) from authenticated;

-- ---------------------------------------------------------------------------
-- 2. pg_cron schedule — fires at 00:00 UTC on the 1st of each month.
--
-- Pattern mirrors migration 20260428000002 (sms-worker-drain): idempotent
-- via the unschedule-if-exists guard. Re-applying the migration reseats
-- the schedule (e.g. after a Vault refresh).
--
-- Senegal = UTC+0, so 00:00 UTC = 00:00 Africa/Dakar. If the project
-- ever expands beyond Senegal, revisit the cron timezone.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from cron.job where jobname = 'safaricash-auto-restart-cycles') then
    perform cron.unschedule('safaricash-auto-restart-cycles');
  end if;

  perform cron.schedule(
    'safaricash-auto-restart-cycles',
    '0 0 1 * *',
    $cron_body$
      select public.restart_active_cycles_for_month(current_date);
    $cron_body$
  );
exception when others then
  raise notice 'safaricash-auto-restart-cycles schedule registration failed: %. Re-run the migration after fixing the pg_cron config.', sqlerrm;
end;
$$;
