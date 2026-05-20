-- Story 11.5 — cap cycle end_date at day 30 (collectors don't work the 31st).
--
-- Amends ADR-004 § Amendment A1: introduces A1.8 (cap rule). The cycle's
-- end_date is now LEAST(last day of month, day 30). For 28/29/30-day months
-- the cap is inert; for 31-day months (Jan, Mar, May, Jul, Aug, Oct, Dec)
-- it shortens the cycle by exactly 1 day.
--
-- Operational context: the pilot collector reports members are always
-- added before the 25th of the month, so the cap never crosses
-- MIN_CYCLE_LENGTH_DAYS (3) in practice. The roll-forward branch is
-- amended too so any defensive call with a late-month date stays
-- consistent with the cap.
--
-- Legacy compat (ADR A1.7) preserved — existing 30-day rows
-- (end_date = start_date + 30 days, length 31) are NOT backfilled and
-- continue to compute identical pre-11.5 numbers via the unchanged
-- record_*/format_sms_body/get_receipt_payload RPCs, which derive cycle
-- length per-row from start_date/end_date.
--
-- TS mirror: src/domain/cycle/cycleEngine.ts MAX_CYCLE_END_DAY.
-- Cross-checked by supabase/functions/_shared/derive-cycle-bounds.contract.test.ts.

set check_function_bodies = off;

create or replace function public.derive_cycle_bounds(p_today date)
returns table(start_date date, end_date date)
language plpgsql
stable
as $$
declare
  v_month_first date := date_trunc('month', p_today)::date;
  -- LEAST(last day of month, 30) — MAX_CYCLE_END_DAY mirrors the TS
  -- constant in src/domain/cycle/cycleEngine.ts (ADR-004 § A1.8).
  -- (v_month_first + 29) is the 30th of the month; same value whether
  -- the month has 28, 29, 30, or 31 days. For Feb (28/29), LEAST falls
  -- back to the actual last day.
  v_month_end   date := least(
    (v_month_first + interval '1 month - 1 day')::date,
    v_month_first + 29
  );
  v_raw_len     integer := (v_month_end - p_today) + 1;
  -- MIN_CYCLE_LENGTH_DAYS in src/domain/cycle/cycleEngine.ts
  -- (ADR-004 § Amendment A1.5). Product-tunable; if raised here, raise
  -- the TS constant in lockstep.
  v_min         constant integer := 3;
  v_next_first  date;
begin
  if v_raw_len >= v_min then
    return query select p_today, v_month_end;
  else
    v_next_first := (v_month_first + interval '1 month')::date;
    return query select
      v_next_first,
      least(
        (v_next_first + interval '1 month - 1 day')::date,
        v_next_first + 29
      );
  end if;
end;
$$;

comment on function public.derive_cycle_bounds(date) is
  'SQL mirror of TS deriveCycleBounds (ADR-004 § Amendment A1.4 + A1.8 / INV-9). Returns (start_date, end_date) for a cycle created today: end = LEAST(last day of month, day 30) — Story 11.5 cap rule; if residual length < MIN_CYCLE_LENGTH_DAYS (3), roll forward to the next month with the same cap. Cross-checked against the TS implementation by supabase/functions/_shared/derive-cycle-bounds.contract.test.ts. STABLE because date_trunc is STABLE.';

-- grant unchanged — already granted to authenticated by migration
-- 20260519215232_calendar_month_cycle_rpcs (CREATE OR REPLACE preserves
-- existing grants).
