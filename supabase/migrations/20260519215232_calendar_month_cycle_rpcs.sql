-- Story 11.3 — calendar-month, variable-length cycle dates in the RPCs.
--
-- Mirrors ADR-004 § Amendment A1 (INV-9 + A1.5 MIN_CYCLE_LENGTH_DAYS +
-- A1.7 legacy compat) and the Story 11.2 TS engine refactor. The
-- TypeScript engine already derives cycle length per-cycle from
-- start_date/end_date; this migration brings the SQL side into the same
-- model. Until 11.3 lands, every cycle written by Postgres is a fixed
-- 30-day window (start + 29 days) — settlement & advance capacity still
-- pass because the engine degrades to × 29 for those rows (ADR A1.7).
--
-- Single migration so the deployment is atomic and idempotent.
--
-- What changes:
--   1. New SQL helper public.derive_cycle_bounds(p_today date) — mirrors
--      TS deriveCycleBounds (month-end + roll-forward at MIN_CYCLE_LENGTH_
--      DAYS = 3, year-aware).
--   2. create_member_with_cycle + restart_member_cycle use the helper.
--   3. commit_cycle_settlement payout × 29 → × (cycleLength − 1) derived
--      from the cycle row's own dates (NFR-R3 cross-check preserved).
--   4. record_advance capacity × 29 → × (cycleLength − 1) derived from
--      the cycle row's own dates (INV-3).
--   5. cycle_day ceiling 30 → 31 across the DB column check on
--      public.transactions AND the validations in record_contribution +
--      record_advance.
--
-- Legacy 30-day rows are unchanged — (end - start + 1) = 30 →
-- (cycleLength - 1) = 29 → identical to the pre-11.3 numbers, no
-- backfill needed (ADR A1.7).

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. derive_cycle_bounds — SQL mirror of TS deriveCycleBounds.
--    Single source of truth on the SQL side; the two cycle-INSERT RPCs
--    + any future caller go through it. A Deno contract test
--    (supabase/functions/_shared/derive-cycle-bounds.contract.test.ts)
--    cross-checks the output against the TS function on representative
--    dates so the two implementations cannot drift.
-- ---------------------------------------------------------------------------

create or replace function public.derive_cycle_bounds(p_today date)
returns table(start_date date, end_date date)
language plpgsql
immutable
as $$
declare
  v_month_end date := (date_trunc('month', p_today)::date + interval '1 month - 1 day')::date;
  v_raw_len   integer := (v_month_end - p_today) + 1;
  -- 3 mirrors MIN_CYCLE_LENGTH_DAYS in src/domain/cycle/cycleEngine.ts
  -- (ADR-004 § Amendment A1.5). Product-tunable; if raised here, raise
  -- the TS constant in lockstep.
  v_min       constant integer := 3;
begin
  if v_raw_len >= v_min then
    return query select p_today, v_month_end;
  else
    -- Roll forward: 1st of next month → last day of next month. date_trunc
    -- handles the Dec → Jan year boundary transparently.
    return query select
      (date_trunc('month', p_today)::date + interval '1 month')::date,
      (date_trunc('month', p_today)::date + interval '2 month - 1 day')::date;
  end if;
end;
$$;

comment on function public.derive_cycle_bounds(date) is
  'SQL mirror of TS deriveCycleBounds (ADR-004 § Amendment A1.4 / INV-9). Returns (start_date, end_date) for a cycle created today: end = last day of month(p_today); if residual length < MIN_CYCLE_LENGTH_DAYS (3), roll forward to the next month. Cross-checked against the TS implementation by supabase/functions/_shared/derive-cycle-bounds.contract.test.ts.';

grant execute on function public.derive_cycle_bounds(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Raise the cycle_day ceiling 30 → 31 (ADR-004 § Amendment A1 — a
--    31-day cycle's last day is day 31). The column check on
--    public.transactions.cycle_day was added as an inline column check
--    in init_schema.sql, so Postgres auto-named it transactions_cycle_
--    day_check. Drop + re-add NOT VALID then VALIDATE so the swap does
--    not synchronously rescan the table (Story 10.5 patch P3 pattern).
-- ---------------------------------------------------------------------------

alter table public.transactions drop constraint if exists transactions_cycle_day_check;
alter table public.transactions
  add constraint transactions_cycle_day_check check (cycle_day between 1 and 31) not valid;
alter table public.transactions validate constraint transactions_cycle_day_check;

-- ---------------------------------------------------------------------------
-- 3. create_member_with_cycle — use derive_cycle_bounds for the day-1
--    cycle window. Body otherwise identical to migration 0014.
-- ---------------------------------------------------------------------------

create or replace function public.create_member_with_cycle(
  p_name         text,
  p_phone_number text,
  p_daily_amount integer,
  p_created_via  public.members_created_via_enum default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id  uuid;
  v_name_secret   uuid;
  v_phone_secret  uuid;
  v_phone_clean   text;
  v_member_id     uuid;
  v_today         date := current_date;
  v_start         date;
  v_end           date;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  if p_name is null or length(trim(p_name)) < 2 then
    raise exception 'invalid_name: must be at least 2 characters after trim' using errcode = '22000';
  end if;
  if length(trim(p_name)) > 80 then
    raise exception 'invalid_name: must be at most 80 characters' using errcode = '22000';
  end if;
  if p_daily_amount is null or p_daily_amount <= 0 then
    raise exception 'invalid_amount: daily_amount must be positive' using errcode = '22000';
  end if;
  if p_daily_amount > 100000 then
    raise exception 'invalid_amount: daily_amount must be at most 100000 FCFA' using errcode = '22000';
  end if;

  v_phone_clean := coalesce(trim(p_phone_number), '');

  v_name_secret  := public.vault_encrypt(trim(p_name));
  v_phone_secret := public.vault_encrypt(v_phone_clean);

  insert into public.members (
    collector_id,
    name_encrypted,
    phone_number_encrypted,
    daily_amount,
    status,
    created_via
  ) values (
    v_collector_id,
    v_name_secret,
    v_phone_secret,
    p_daily_amount,
    'active',
    p_created_via
  )
  returning id into v_member_id;

  -- Story 11.3 — derive the calendar-month cycle bounds (variable length;
  -- may roll forward when fewer than MIN_CYCLE_LENGTH_DAYS remain).
  select b.start_date, b.end_date
    into v_start, v_end
    from public.derive_cycle_bounds(v_today) as b;

  insert into public.cycles (
    collector_id,
    member_id,
    cycle_number,
    start_date,
    end_date,
    status
  ) values (
    v_collector_id,
    v_member_id,
    1,
    v_start,
    v_end,
    'active'
  );

  return v_member_id;
end;
$$;

comment on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) is
  'Atomic member + day-1 cycle creation. Story 11.3: day-1 cycle bounds come from derive_cycle_bounds(today) — calendar-month-aligned, may roll forward when < MIN_CYCLE_LENGTH_DAYS remain. Used by Story 2.2 (manual) and Story 2.3 (contacts import). Both INSERTs share the function transaction. Audit event member.created fires via the migration 0007 trigger.';

revoke all on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) from public;
revoke all on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) from anon;
grant execute on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. restart_member_cycle — same calendar-month bounds for the new cycle.
-- ---------------------------------------------------------------------------

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
  v_start           date;
  v_end             date;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(0x5AFB, hashtext(p_member_id::text));

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

  select status, cycle_number
    into v_latest_status, v_latest_number
    from public.cycles
   where member_id = p_member_id
   order by cycle_number desc
   limit 1;

  if v_latest_number is null then
    raise exception 'not_restartable: member % has no prior cycle', p_member_id
      using errcode = '22000';
  end if;

  if v_latest_status not in ('completed', 'settled') then
    raise exception 'not_restartable: latest cycle status is %', v_latest_status
      using errcode = '22000';
  end if;

  -- Story 11.3 — derive calendar-month bounds for the fresh cycle.
  select b.start_date, b.end_date
    into v_start, v_end
    from public.derive_cycle_bounds(v_today) as b;

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
    v_start,
    v_end,
    'active'
  )
  returning id into v_new_cycle_id;

  return v_new_cycle_id;
end;
$$;

grant execute on function public.restart_member_cycle(uuid) to authenticated;

comment on function public.restart_member_cycle(uuid) is
  'Atomic cycle restart (Story 2.7 / FR12). Story 11.3: fresh cycle bounds come from derive_cycle_bounds(today) — calendar-month-aligned, may roll forward when residual is short. Inserts cycle_number = prev + 1 with status=active. Per-member advisory lock prevents racing INSERTs. Raises 28000 (unauthorized), 22000 (not_restartable), P0002 (not_found). Audit cycle.started fires via the migration 0007 trigger.';

-- ---------------------------------------------------------------------------
-- 5. commit_cycle_settlement — payout × (cycleLength − 1), derived from
--    the cycle row's own dates. NFR-R3 cross-check preserved.
--    Note: the synthetic settlement transaction's cycle_day is now the
--    cycle's last day (= cycleLength), not the literal 30.
-- ---------------------------------------------------------------------------

create or replace function public.commit_cycle_settlement(
  p_member_id        uuid,
  p_cycle_id         uuid,
  p_expected_payout  bigint
) returns table (
  settlement_transaction_id  uuid,
  settled_payout             bigint,
  settled_at                 timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id      uuid;
  v_cycle             public.cycles%rowtype;
  v_member            public.members%rowtype;
  v_advances_sum      bigint;
  v_cycle_length      integer;
  v_contribution_days integer;
  v_computed_payout   bigint;
  v_amount_secret     uuid;
  v_tx_id             uuid;
  v_settled_at        timestamptz;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'cycle_settlement: auth required' using errcode = '28000';
  end if;

  select * into v_cycle
    from public.cycles
   where id = p_cycle_id
   for update;

  if not found then
    raise exception 'cycle_settlement: cycle not found or not owned'
      using errcode = 'P0002';
  end if;

  if v_cycle.collector_id <> v_collector_id then
    raise exception 'cycle_settlement: cycle not found or not owned'
      using errcode = 'P0002';
  end if;

  if v_cycle.member_id <> p_member_id then
    raise exception 'cycle_settlement: cycle/member mismatch'
      using errcode = 'P0002';
  end if;

  if v_cycle.status <> 'completed' then
    raise exception 'cycle_settlement: cycle not in completed status (got %s)', v_cycle.status
      using errcode = 'P0002',
            detail = format('cycle_id=%s status=%s', p_cycle_id, v_cycle.status);
  end if;

  select * into v_member
    from public.members
   where id = p_member_id;

  if not found then
    raise exception 'cycle_settlement: cycle/member mismatch'
      using errcode = 'P0002';
  end if;

  -- Server-side payout recompute — Story 11.3 / ADR-004 INV-2.
  -- Formula: daily_amount × contributionDays − Σ(advances where undone_at IS NULL).
  -- contributionDays = (end_date − start_date + 1) − 1 = cycleLength − 1.
  -- Mirrors TS settle(daily_amount, advances, contributionDays). For legacy
  -- 30-day rows (start + 29) this evaluates to × 29 — identical to the
  -- pre-11.3 numbers (ADR A1.7).
  v_cycle_length := (v_cycle.end_date - v_cycle.start_date) + 1;
  v_contribution_days := v_cycle_length - 1;

  select coalesce(sum(public.vault_decrypt(t.amount_encrypted)::numeric(12, 0)), 0)::bigint
    into v_advances_sum
    from public.transactions t
   where t.cycle_id = p_cycle_id
     and t.kind = 'advance'
     and t.undone_at is null;

  v_computed_payout := (v_member.daily_amount::bigint * v_contribution_days) - v_advances_sum;

  -- NFR-R3 zero-tolerance cross-check.
  if v_computed_payout <> p_expected_payout then
    raise exception 'cycle_settlement: payout mismatch (client=%s, server=%s)',
                    p_expected_payout, v_computed_payout
      using errcode = 'P0002',
            detail = format('client_payout=%s server_payout=%s',
                            p_expected_payout, v_computed_payout);
  end if;

  v_amount_secret := public.vault_encrypt(v_computed_payout::text);

  -- Story 11.3 — synthetic settlement tx is stamped at the cycle's
  -- LAST day (= cycleLength), not the literal 30. For a 24-day cycle
  -- this lands at 24; for a 31-day cycle at 31 (admitted by the new
  -- transactions_cycle_day_check ceiling of 31).
  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'settlement',
    v_amount_secret, v_cycle_length, 'online'
  )
  returning id into v_tx_id;

  v_settled_at := now();
  update public.cycles
     set status = 'settled',
         settled_at = v_settled_at,
         updated_at = v_settled_at
   where id = p_cycle_id;

  return query select v_tx_id, v_computed_payout, v_settled_at;
end;
$$;

grant execute on function public.commit_cycle_settlement(uuid, uuid, bigint) to authenticated;

comment on function public.commit_cycle_settlement(uuid, uuid, bigint) is
  'Atomic settlement commit (Story 7.4 / FR21 / NFR-R3). Story 11.3: payout = daily_amount × ((end_date − start_date + 1) − 1) − Σ advances — mirrors TS settle() for variable-length cycles. Synthetic settlement tx is stamped at cycle_day = cycleLength. Locks cycle FOR UPDATE, asserts status=''completed'' + ownership, cross-checks recomputed payout vs. p_expected_payout, inserts synthetic kind=''settlement'' transaction (fires SMS queue), UPDATEs cycle.status=''settled'' (fires audit cycle.settled). Caller MUST have passed re-auth (Story 1.5b verifyPassword).';

-- ---------------------------------------------------------------------------
-- 6. record_advance — capacity × (cycleLength − 1) derived from the cycle
--    row's dates. cycle_day ceiling raised 30 → 31.
-- ---------------------------------------------------------------------------

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
  v_cycle_start       date;
  v_cycle_end         date;
  v_contribution_days integer;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount: amount must be positive' using errcode = '22000';
  end if;
  -- Story 11.3 — ceiling raised 30 → 31 to admit day-31 of a 31-day cycle.
  if p_cycle_day is null or p_cycle_day < 1 or p_cycle_day > 31 then
    raise exception 'invalid_cycle_day: cycle_day must be in [1, 31]' using errcode = '22000';
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

  -- Story 11.3 — capacity is bounded by THIS cycle's own length
  -- (= cycleLength − 1 contribution days), not the legacy × 29.
  -- For a legacy 30-day row (start + 29) this evaluates to × 29 →
  -- numbers identical to the pre-11.3 behaviour (ADR A1.7).
  select c.start_date, c.end_date
    into v_cycle_start, v_cycle_end
    from public.cycles c
   where c.id = p_cycle_id;
  if v_cycle_start is null then
    raise exception 'not_found: cycle % does not exist', p_cycle_id using errcode = 'P0002';
  end if;
  v_contribution_days := (v_cycle_end - v_cycle_start + 1) - 1;

  -- Server-side capacity check (defence-in-depth on Story 5.1's client
  -- gate). Reads decrypted advance amounts via transactions_decrypted
  -- (Story 4.5 view filters undone_at IS NULL automatically).
  select coalesce(sum(amount), 0)
    into v_existing_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id
     and kind = 'advance';

  v_capacity := v_daily_amount * v_contribution_days;
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
  'Atomic advance insert (Story 5.4 / FR24 + FR25). SECURITY DEFINER. Story 11.3: capacity ceiling is daily_amount × ((end_date − start_date + 1) − 1) read from the cycle row (variable length per ADR-004 INV-3); cycle_day ceiling raised 30 → 31. Validates ownership + amount + cycle_day [1,31] + motive (≥ 3 chars) + saver_acknowledged + capacity. Story 3.4 BEFORE INSERT trigger rejects closed cycles (23514); Story 4.3 enqueue_sms_on_transaction trigger fires; Story 3.3 promote_cycle_on_advance flips active → with_advance + emits cycle.transitioned audit.';

-- ---------------------------------------------------------------------------
-- 7. record_contribution — cycle_day ceiling 30 → 31.
-- ---------------------------------------------------------------------------

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
  -- Story 11.3 — ceiling raised 30 → 31 to admit day-31 of a 31-day cycle.
  if p_cycle_day is null or p_cycle_day < 1 or p_cycle_day > 31 then
    raise exception 'invalid_cycle_day: cycle_day must be in [1, 31]' using errcode = '22000';
  end if;

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
  'Atomic contribution insert (Story 4.3 / FR22). Story 11.3: cycle_day ceiling raised 30 → 31 to admit the last day of a 31-day calendar-month cycle. Encrypts amount via Vault, inserts transactions row with kind=contribution + source=online. Story 3.4 BEFORE INSERT trigger rejects on closed cycles (23514). Story 6.x AFTER INSERT trigger enqueues sms_queue row. Audit transaction.committed fires via existing trigger.';
