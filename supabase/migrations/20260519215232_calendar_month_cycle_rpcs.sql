-- Story 11.3 — calendar-month, variable-length cycle dates in the RPCs.
--
-- Mirrors ADR-004 § Amendment A1 (INV-9 + A1.5 MIN_CYCLE_LENGTH_DAYS +
-- A1.7 legacy compat) and the Story 11.2 TS engine refactor. The
-- TypeScript engine derives cycle length per-cycle from start_date/end_date;
-- this migration brings the SQL side into the same model.
--
-- The 11.2 code-review handoff (story file § "Handoff to Story 11.3")
-- widened the scope from the original Sprint Change Proposal: this story
-- also closes record_advance, record_rattrapage (cycle_day ceiling +
-- days_covered overflow), format_sms_body (the saver's SMS projected
-- balance is MATH not display copy — NFR-R3), and get_receipt_payload
-- (the receipt URL projected balance — same NFR-R3 concern).
--
-- IMPORTANT — overload handling.
-- The latest signatures of the three idempotent RPCs (Story 8.4 added
-- `p_event_id uuid DEFAULT NULL` as the trailing parameter) are:
--   record_advance      (uuid,uuid,integer,integer,text,boolean,uuid)
--   record_contribution (uuid,uuid,integer,integer,uuid)
--   record_rattrapage   (uuid,uuid,integer,integer,integer,uuid)
-- An earlier draft of this migration used CREATE OR REPLACE on the
-- pre-8.4 signatures, which Postgres treats as a NEW overload (not a
-- replacement). The result was: online callers hit the new (broken)
-- overload, reconciler callers hit the old (× 29) overload. We DROP both
-- of the buggy overloads up-front before recreating the latest ones, so
-- the migration is convergent regardless of whether the buggy version
-- ever ran against a particular database.
--
-- Legacy 30-day rows degrade to identical pre-11.3 numbers
-- ((end - start + 1) - 1 = 29 — ADR A1.7). No data backfill.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. derive_cycle_bounds — SQL mirror of TS deriveCycleBounds.
--    STABLE (not IMMUTABLE): calls date_trunc, which Postgres marks STABLE.
--    A function calling STABLE helpers cannot itself be IMMUTABLE without
--    risking constant-folding for future callers that pass current_date
--    directly. Current callers materialise current_date into a variable
--    first, but STABLE is the correct contract.
-- ---------------------------------------------------------------------------

create or replace function public.derive_cycle_bounds(p_today date)
returns table(start_date date, end_date date)
language plpgsql
stable
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
    return query select
      (date_trunc('month', p_today)::date + interval '1 month')::date,
      (date_trunc('month', p_today)::date + interval '2 month - 1 day')::date;
  end if;
end;
$$;

comment on function public.derive_cycle_bounds(date) is
  'SQL mirror of TS deriveCycleBounds (ADR-004 § Amendment A1.4 / INV-9). Returns (start_date, end_date) for a cycle created today: end = last day of month(p_today); if residual length < MIN_CYCLE_LENGTH_DAYS (3), roll forward to the next month. Cross-checked against the TS implementation by supabase/functions/_shared/derive-cycle-bounds.contract.test.ts. STABLE because date_trunc is STABLE.';

grant execute on function public.derive_cycle_bounds(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. cycle_day ceiling 30 → 31 — DB column check first, then the RPC
--    validations below. NOT VALID + VALIDATE avoids a synchronous lock
--    scan (Story 10.5 patch P3 pattern).
-- ---------------------------------------------------------------------------

alter table public.transactions drop constraint if exists transactions_cycle_day_check;
alter table public.transactions
  add constraint transactions_cycle_day_check check (cycle_day between 1 and 31) not valid;
alter table public.transactions validate constraint transactions_cycle_day_check;

-- ---------------------------------------------------------------------------
-- 3. DROP the buggy overloads an earlier draft of this migration created.
--    If this migration is being applied to a database that already ran
--    the buggy draft, these DROPs remove the unreachable / broken
--    duplicates; on a clean DB they are no-ops.
-- ---------------------------------------------------------------------------

drop function if exists public.record_advance(uuid, uuid, integer, integer, text, boolean);
drop function if exists public.record_contribution(uuid, uuid, integer, integer);

-- ---------------------------------------------------------------------------
-- 4. create_member_with_cycle — day-1 cycle bounds via derive_cycle_bounds.
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
    collector_id, name_encrypted, phone_number_encrypted, daily_amount, status, created_via
  ) values (
    v_collector_id, v_name_secret, v_phone_secret, p_daily_amount, 'active', p_created_via
  )
  returning id into v_member_id;

  -- Story 11.3 — derive calendar-month cycle bounds.
  select b.start_date, b.end_date
    into v_start, v_end
    from public.derive_cycle_bounds(v_today) as b;

  insert into public.cycles (collector_id, member_id, cycle_number, start_date, end_date, status)
  values (v_collector_id, v_member_id, 1, v_start, v_end, 'active');

  return v_member_id;
end;
$$;

comment on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) is
  'Atomic member + day-1 cycle creation. Story 11.3: day-1 cycle bounds come from derive_cycle_bounds(today) — calendar-month-aligned, may roll forward when < MIN_CYCLE_LENGTH_DAYS remain. Used by Story 2.2 (manual) and Story 2.3 (contacts import). Audit event member.created fires via the migration 0007 trigger.';

revoke all on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) from public;
revoke all on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) from anon;
grant execute on function public.create_member_with_cycle(text, text, integer, public.members_created_via_enum) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. restart_member_cycle — same.
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

  select collector_id into v_member_owner from public.members where id = p_member_id;

  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_member_id using errcode = 'P0002';
  end if;
  if v_member_owner <> v_collector_id then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id
      using errcode = '28000';
  end if;

  select status, cycle_number into v_latest_status, v_latest_number
    from public.cycles where member_id = p_member_id
    order by cycle_number desc limit 1;

  if v_latest_number is null then
    raise exception 'not_restartable: member % has no prior cycle', p_member_id using errcode = '22000';
  end if;

  if v_latest_status not in ('completed', 'settled') then
    raise exception 'not_restartable: latest cycle status is %', v_latest_status using errcode = '22000';
  end if;

  select b.start_date, b.end_date into v_start, v_end
    from public.derive_cycle_bounds(v_today) as b;

  insert into public.cycles (collector_id, member_id, cycle_number, start_date, end_date, status)
  values (v_collector_id, p_member_id, v_latest_number + 1, v_start, v_end, 'active')
  returning id into v_new_cycle_id;

  return v_new_cycle_id;
end;
$$;

grant execute on function public.restart_member_cycle(uuid) to authenticated;

comment on function public.restart_member_cycle(uuid) is
  'Atomic cycle restart (Story 2.7 / FR12). Story 11.3: fresh cycle bounds from derive_cycle_bounds(today). Per-member advisory lock prevents racing INSERTs.';

-- ---------------------------------------------------------------------------
-- 6. commit_cycle_settlement — payout × (cycleLength − 1). Synthetic
--    settlement tx stamped at cycle_day = cycleLength (the cycle's last
--    day), admitted by the new BETWEEN 1 AND 31 column check.
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

  select * into v_cycle from public.cycles where id = p_cycle_id for update;
  if not found then
    raise exception 'cycle_settlement: cycle not found or not owned' using errcode = 'P0002';
  end if;
  if v_cycle.collector_id <> v_collector_id then
    raise exception 'cycle_settlement: cycle not found or not owned' using errcode = 'P0002';
  end if;
  if v_cycle.member_id <> p_member_id then
    raise exception 'cycle_settlement: cycle/member mismatch' using errcode = 'P0002';
  end if;
  if v_cycle.status <> 'completed' then
    raise exception 'cycle_settlement: cycle not in completed status (got %s)', v_cycle.status
      using errcode = 'P0002',
            detail = format('cycle_id=%s status=%s', p_cycle_id, v_cycle.status);
  end if;

  select * into v_member from public.members where id = p_member_id;
  if not found then
    raise exception 'cycle_settlement: cycle/member mismatch' using errcode = 'P0002';
  end if;

  -- Story 11.3 — payout derived from THIS cycle's own length.
  -- (cycleLength − 1) = contributionDays. For legacy 30-day rows
  -- (end_date = start_date + 29) this evaluates to × 29 — identical
  -- to pre-11.3 numbers (ADR A1.7).
  v_cycle_length := (v_cycle.end_date - v_cycle.start_date) + 1;
  v_contribution_days := v_cycle_length - 1;

  select coalesce(sum(public.vault_decrypt(t.amount_encrypted)::numeric(12, 0)), 0)::bigint
    into v_advances_sum
    from public.transactions t
   where t.cycle_id = p_cycle_id and t.kind = 'advance' and t.undone_at is null;

  v_computed_payout := (v_member.daily_amount::bigint * v_contribution_days) - v_advances_sum;

  -- NFR-R3 zero-tolerance cross-check.
  if v_computed_payout <> p_expected_payout then
    raise exception 'cycle_settlement: payout mismatch (client=%s, server=%s)',
                    p_expected_payout, v_computed_payout
      using errcode = 'P0002',
            detail = format('client_payout=%s server_payout=%s', p_expected_payout, v_computed_payout);
  end if;

  v_amount_secret := public.vault_encrypt(v_computed_payout::text);

  -- Story 11.3 — synthetic settlement tx stamped at cycle_day = cycleLength
  -- (was the literal 30). For a 24-day cycle: 24; for a 31-day cycle: 31.
  insert into public.transactions (
    collector_id, member_id, cycle_id, kind, amount_encrypted, cycle_day, source
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'settlement',
    v_amount_secret, v_cycle_length, 'online'
  )
  returning id into v_tx_id;

  v_settled_at := now();
  update public.cycles
     set status = 'settled', settled_at = v_settled_at, updated_at = v_settled_at
   where id = p_cycle_id;

  return query select v_tx_id, v_computed_payout, v_settled_at;
end;
$$;

grant execute on function public.commit_cycle_settlement(uuid, uuid, bigint) to authenticated;

comment on function public.commit_cycle_settlement(uuid, uuid, bigint) is
  'Atomic settlement commit (Story 7.4 / FR21 / NFR-R3). Story 11.3: payout = daily_amount × ((end_date − start_date + 1) − 1) − Σ advances — mirrors TS settle() for variable-length cycles. Synthetic settlement tx stamped at cycle_day = cycleLength. Caller MUST have passed re-auth before invoking.';

-- ---------------------------------------------------------------------------
-- 7. record_advance — LATEST signature (7-arg, Story 4.6 + 8.4) +
--    variable-length capacity + cycle_day ≤ 31. Idempotent early-return
--    + optional motive (no length guard) preserved.
-- ---------------------------------------------------------------------------

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
  v_collector_id      uuid;
  v_member_owner      uuid;
  v_daily_amount      numeric(12, 0);
  v_existing_total    numeric(12, 0);
  v_capacity          numeric(12, 0);
  v_amount_secret     uuid;
  v_motive_trimmed    text;
  v_tx_id             uuid;
  v_existing_tx_id    uuid;
  v_cycle_start       date;
  v_cycle_end         date;
  v_contribution_days integer;
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
  -- Story 11.3 — ceiling raised 30 → 31 to admit day-31 of a 31-day cycle.
  if p_cycle_day is null or p_cycle_day < 1 or p_cycle_day > 31 then
    raise exception 'invalid_cycle_day: cycle_day must be in [1, 31]' using errcode = '22000';
  end if;

  -- Story 4.6 — motive is optional; normalise to a trimmed string ('' when
  -- blank). No length guard. Constraint transactions_advance_motive_ack_chk
  -- still requires non-null + saver_acknowledged = true for kind='advance'.
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

  -- Story 11.3 — capacity bound from THIS cycle's own length. Legacy
  -- 30-day rows degrade to × 29 (ADR A1.7).
  select c.start_date, c.end_date into v_cycle_start, v_cycle_end
    from public.cycles c where c.id = p_cycle_id;
  if v_cycle_start is null then
    raise exception 'not_found: cycle % does not exist', p_cycle_id using errcode = 'P0002';
  end if;
  v_contribution_days := (v_cycle_end - v_cycle_start + 1) - 1;

  select coalesce(sum(amount), 0) into v_existing_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id and kind = 'advance';

  v_capacity := v_daily_amount * v_contribution_days;
  if v_existing_total + p_amount > v_capacity then
    raise exception 'over_limit: advance exceeds projected available balance (existing=% + new=% > capacity=%)',
      v_existing_total, p_amount, v_capacity using errcode = '22023';
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
  'Atomic advance insert (Story 5.4 / FR24 + FR25). Story 4.6: motive optional. Story 8.4: idempotent via p_event_id. Story 11.3: capacity = daily_amount × ((end_date − start_date + 1) − 1) from the cycle row (variable length, ADR INV-3); cycle_day ceiling raised 30 → 31.';

-- ---------------------------------------------------------------------------
-- 8. record_contribution — LATEST signature (5-arg, Story 8.4) +
--    cycle_day ≤ 31. Idempotent early-return preserved.
-- ---------------------------------------------------------------------------

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
  -- Story 11.3 — ceiling raised 30 → 31.
  if p_cycle_day is null or p_cycle_day < 1 or p_cycle_day > 31 then
    raise exception 'invalid_cycle_day: cycle_day must be in [1, 31]' using errcode = '22000';
  end if;

  select collector_id into v_member_owner from public.members where id = p_member_id;
  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_member_id using errcode = 'P0002';
  end if;
  if v_member_owner <> v_collector_id then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id using errcode = '28000';
  end if;

  v_amount_secret := public.vault_encrypt(p_amount::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind, amount_encrypted, cycle_day, source, event_id
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'contribution',
    v_amount_secret, p_cycle_day,
    -- Explicit cast required: under PG 17 strict mode, a CASE branching on
    -- two text literals types to TEXT and is no longer implicit-cast to
    -- the enum at INSERT time (SQLSTATE 42804). The Story 8.4 migration
    -- lacked this cast; Story 4.6's record_advance had it. Add it here.
    (case when p_event_id is null then 'online' else 'offline_reconciled' end)::transactions_source_enum,
    p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_contribution(uuid, uuid, integer, integer, uuid) to authenticated;

comment on function public.record_contribution(uuid, uuid, integer, integer, uuid) is
  'Atomic contribution insert (Story 4.3 / FR22). Story 8.4: idempotent via p_event_id. Story 11.3: cycle_day ceiling raised 30 → 31 to admit the last day of a 31-day calendar-month cycle.';

-- ---------------------------------------------------------------------------
-- 9. record_rattrapage — LATEST signature (6-arg, Story 8.4) + cycle_day
--    ≤ 31 + days_covered overflow bound by THIS cycle's length (was a
--    hardcoded 30). Idempotent early-return preserved.
-- ---------------------------------------------------------------------------

create or replace function public.record_rattrapage(
  p_member_id     uuid,
  p_cycle_id      uuid,
  p_daily_amount  integer,
  p_cycle_day     integer,
  p_days_covered  integer,
  p_event_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id      uuid;
  v_member_owner      uuid;
  v_amount_secret     uuid;
  v_total             integer;
  v_tx_id             uuid;
  v_existing_tx_id    uuid;
  v_cycle_start       date;
  v_cycle_end         date;
  v_cycle_length      integer;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  if p_event_id is not null then
    select id into v_existing_tx_id
      from public.transactions
     where event_id = p_event_id and collector_id = v_collector_id;
    if v_existing_tx_id is not null then
      return v_existing_tx_id;
    end if;
  end if;

  if p_daily_amount is null or p_daily_amount <= 0 then
    raise exception 'invalid_amount: daily_amount must be positive' using errcode = '22000';
  end if;
  -- Story 11.3 — ceiling raised 30 → 31.
  if p_cycle_day is null or p_cycle_day < 1 or p_cycle_day > 31 then
    raise exception 'invalid_cycle_day: cycle_day must be in [1, 31]' using errcode = '22000';
  end if;
  if p_days_covered is null or p_days_covered < 2 or p_days_covered > 4 then
    raise exception 'invalid_days_covered: days_covered must be in [2, 4]' using errcode = '22000';
  end if;

  -- Story 11.3 — overflow check bound by THIS cycle's length, not the
  -- hardcoded 30. Read the cycle row.
  select c.start_date, c.end_date into v_cycle_start, v_cycle_end
    from public.cycles c where c.id = p_cycle_id;
  if v_cycle_start is null then
    raise exception 'not_found: cycle % does not exist', p_cycle_id using errcode = 'P0002';
  end if;
  v_cycle_length := (v_cycle_end - v_cycle_start) + 1;

  if p_cycle_day + p_days_covered - 1 > v_cycle_length then
    raise exception 'invalid_days_covered: rattrapage exceeds cycle remaining (cycle_day=% + days_covered=% > cycleLength=%)',
      p_cycle_day, p_days_covered, v_cycle_length using errcode = '22000';
  end if;

  select collector_id into v_member_owner from public.members where id = p_member_id;
  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_member_id using errcode = 'P0002';
  end if;
  if v_member_owner <> v_collector_id then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id using errcode = '28000';
  end if;

  v_total := p_daily_amount * p_days_covered;
  v_amount_secret := public.vault_encrypt(v_total::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source, days_covered, event_id
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'rattrapage',
    v_amount_secret, p_cycle_day,
    -- Same PG-17-strict CASE-to-enum cast as record_contribution above.
    (case when p_event_id is null then 'online' else 'offline_reconciled' end)::transactions_source_enum,
    p_days_covered, p_event_id
  )
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.record_rattrapage(uuid, uuid, integer, integer, integer, uuid) to authenticated;

comment on function public.record_rattrapage(uuid, uuid, integer, integer, integer, uuid) is
  'Atomic rattrapage insert (Story 4.4 / FR23). Story 8.4: idempotent via p_event_id. Story 11.3: cycle_day ceiling raised 30 → 31; days_covered overflow bound by the cycle row''s own length (end_date − start_date + 1) — variable per calendar month.';

-- ---------------------------------------------------------------------------
-- 10. format_sms_body — v_projected uses THIS cycle's contributionDays.
--     The saver's SMS receipt is NFR-R3 territory: the projected number
--     must match what the engine + settlement RPC compute. Legacy 30-day
--     rows yield × 29 — identical to pre-11.3 (ADR A1.7).
--
--     Full body reproduced from 20260517001214 (Story 10.5 — latest);
--     only `v_projected` derivation changes. The `/30` denominator in
--     the displayed SMS text remains for Story 11.4 (pure display copy).
-- ---------------------------------------------------------------------------

create or replace function public.format_sms_body(p_template_key text, p_transaction_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_tx              record;
  v_member          record;
  v_advances_sum    numeric(12, 0);
  v_amount          numeric(12, 0);
  v_projected       numeric(12, 0);
  v_url_base        text;
  v_url             text;
  v_prenom          text;
  v_amount_str      text;
  v_projected_str   text;
  v_dispute_ref     text;
  v_cycle_start_str text;
  v_cycle_end_str   text;
  v_cycle_start     date;
  v_cycle_end       date;
  v_contribution_days integer;
begin
  if p_template_key not in ('first_receipt', 'subsequent_receipt', 'settlement', 'dispute_ack', 'opt_out_confirmation') then
    raise exception 'invalid_template_key: % is not a recognised template', p_template_key
      using errcode = '22000';
  end if;

  if p_template_key = 'opt_out_confirmation' then
    return 'SafariCash. Vous ne recevrez plus de SMS. Pour les reactiver, contactez votre collecteur.';
  end if;

  select t.id, t.member_id, t.cycle_id, t.kind, t.cycle_day, t.receipt_token,
         nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount
    into v_tx
    from public.transactions t
   where t.id = p_transaction_id;

  if v_tx.id is null then
    raise exception 'transaction_not_found: % does not exist', p_transaction_id using errcode = 'P0002';
  end if;

  v_amount := v_tx.amount;

  v_url_base := coalesce(nullif(current_setting('app.receipt_url_base', true), ''), 'https://safaricash.app/r');
  v_url := v_url_base || '/' || v_tx.receipt_token;

  v_amount_str := replace(to_char(v_amount, 'FM999G999G999'), ',', ' ');

  if p_template_key = 'first_receipt' or p_template_key = 'subsequent_receipt' then
    select unaccent(public.vault_decrypt(m.name_encrypted)) as full_name, m.daily_amount
      into v_member
      from public.members m
     where m.id = v_tx.member_id;

    v_prenom := substring(coalesce(split_part(v_member.full_name, ' ', 1), 'Saver') from 1 for 16);
    if v_prenom = '' then v_prenom := 'Saver'; end if;

    select coalesce(sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0)), 0)
      into v_advances_sum
      from public.transactions t2
     where t2.cycle_id = v_tx.cycle_id and t2.kind = 'advance' and t2.undone_at is null;

    -- Story 11.3 — projected balance derived from THIS cycle's own
    -- contributionDays (= cycleLength − 1), not the legacy × 29. Mirrors
    -- the TS computeProjectedFinalBalance the saver sees in-app.
    select c.start_date, c.end_date into v_cycle_start, v_cycle_end
      from public.cycles c where c.id = v_tx.cycle_id;
    v_contribution_days := (v_cycle_end - v_cycle_start + 1) - 1;
    v_projected := v_member.daily_amount * v_contribution_days - v_advances_sum;
    v_projected_str := replace(to_char(v_projected, 'FM999G999G999'), ',', ' ');

    if p_template_key = 'first_receipt' then
      return format(
        'Bonjour %s. Recu SafariCash: %s FCFA, jour %s/30. Solde projete fin de cycle: %s FCFA. Detail: %s. SafariCash est un journal d''epargne et non une banque. Repondez STOP pour ne plus recevoir.',
        v_prenom, v_amount_str, v_tx.cycle_day, v_projected_str, v_url
      );
    else
      return format(
        'SafariCash. %s FCFA recu, jour %s/30. Solde projete: %s FCFA. Detail: %s.',
        v_amount_str, v_tx.cycle_day, v_projected_str, v_url
      );
    end if;
  end if;

  if p_template_key = 'settlement' then
    select unaccent(public.vault_decrypt(m.name_encrypted)) as full_name
      into v_member
      from public.members m
     where m.id = v_tx.member_id;

    v_prenom := substring(coalesce(split_part(v_member.full_name, ' ', 1), 'Saver') from 1 for 9);
    if v_prenom = '' then v_prenom := 'Saver'; end if;

    select to_char(c.start_date, 'DD/MM'), to_char(c.end_date, 'DD/MM')
      into v_cycle_start_str, v_cycle_end_str
      from public.cycles c
     where c.id = v_tx.cycle_id;

    return format(
      'SafariCash. %s, votre cycle du %s au %s est clos. Vous avez recu %s FCFA. Detail: %s.',
      v_prenom, v_cycle_start_str, v_cycle_end_str,
      to_char(v_amount, 'FM999999999'), v_url
    );
  end if;

  -- p_template_key = 'dispute_ack'
  select substring(d.id::text from 1 for 8)
    into v_dispute_ref
    from public.disputes d
   where d.transaction_id = p_transaction_id
   order by d.flagged_at desc
   limit 1;

  if v_dispute_ref is null then
    v_dispute_ref := 'pending';
  end if;

  return format(
    'SafariCash. Votre signalement a ete recu. Reponse sous 48h. Reference: %s.',
    v_dispute_ref
  );
end;
$function$;

comment on function public.format_sms_body(text, uuid) is
  'Story 11.3: SMS projected balance (first_receipt + subsequent_receipt) derived from THIS cycle''s contributionDays (= cycleLength − 1). The displayed "/30" denominator remains for Story 11.4 (pure display copy). Story 10.5 opt_out_confirmation + Story 7.5 settlement + Story 10.2 dispute_ack templates preserved.';

grant execute on function public.format_sms_body(text, uuid) to authenticated, service_role;
revoke execute on function public.format_sms_body(text, uuid) from public;

-- ---------------------------------------------------------------------------
-- 11. get_receipt_payload — projected_balance uses THIS cycle's
--     contributionDays. Same NFR-R3 concern (saver sees this on the
--     receipt URL page).
-- ---------------------------------------------------------------------------

drop function if exists public.get_receipt_payload(text);

create function public.get_receipt_payload(p_token text)
returns table (
  amount             numeric(12, 0),
  kind               text,
  cycle_day          int,
  created_at         timestamptz,
  member_first_name  text,
  projected_balance  numeric(12, 0),
  daily_amount       numeric(12, 0),
  cycle_start_date   date,
  cycle_end_date     date,
  anonymised_at      timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount,
    t.kind::text,
    t.cycle_day,
    t.created_at,
    substring(unaccent(public.vault_decrypt(m.name_encrypted)) from '^[^ ]+') as member_first_name,
    -- Story 11.3 — projected balance derived from THIS cycle's
    -- contributionDays (= cycleLength − 1) read from the joined cycle
    -- row. Legacy 30-day rows degrade to × 29 (ADR A1.7).
    (m.daily_amount * ((c.end_date - c.start_date + 1) - 1)) - coalesce(
      (
        select sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0))
          from public.transactions t2
         where t2.cycle_id = t.cycle_id
           and t2.kind = 'advance'
           and t2.undone_at is null
      ),
      0
    ) as projected_balance,
    m.daily_amount,
    c.start_date as cycle_start_date,
    c.end_date   as cycle_end_date,
    m.anonymised_at
  from public.transactions t
  join public.members m on m.id = t.member_id
  join public.cycles  c on c.id = t.cycle_id
  where t.receipt_token = p_token
    and t.undone_at is null;
$$;

comment on function public.get_receipt_payload(text) is
  'Story 11.3: projected_balance = daily_amount × ((end_date − start_date + 1) − 1) − Σ advances — derived from the joined cycle row (variable length per ADR-004 INV-9). Story 10.5 anonymised_at + Story 7.5 cycle dates + Story 6.4 baseline preserved.';

grant execute on function public.get_receipt_payload(text) to service_role;
revoke execute on function public.get_receipt_payload(text) from public;
revoke execute on function public.get_receipt_payload(text) from authenticated;
