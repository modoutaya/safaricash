-- Story 12.3 Phase A — opening_balance carry-over across cycles.
--
-- Spec: _bmad-output/implementation-artifacts/12-3-cycle-auto-restart-with-carryover.md
--
-- Q1 = Path A (resolved 2026-05-20): opening_balance is NOT stored. It is
-- a derived quantity computed recursively from the previous unsettled cycle.
-- This single migration introduces the helper + updates the 4 financial
-- RPCs that consume it in lockstep. Atomic so the DB state is never half-
-- transformed.
--
-- RPCs touched (CREATE OR REPLACE on identical signatures, or DROP + CREATE
-- when the return shape changes):
--   1. record_advance              — capacity check subtracts opening_balance
--   2. commit_cycle_settlement     — payout subtracts opening_balance
--   3. format_sms_body             — receipt SMS projected balance subtracts opening_balance
--   4. get_receipt_payload         — receipt URL projected balance subtracts opening_balance
--
-- NFR-R3 zero-tolerance: the math here must match the TS engine
-- (src/domain/cycle/cycleEngine.ts) byte-for-byte. The TS mirror is
-- updated in the same PR; a contract test (Deno) cross-checks both
-- implementations on a battery of cycle states.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. compute_opening_balance — recursive helper, Q1 Path A.
--
-- Returns the debt amount (≥ 0) carried over from the previous unsettled
-- cycle of the same member. Returns 0 when:
--   - The cycle is the member's first (cycle_number = 1).
--   - The previous cycle is 'settled' (the chain restarts).
--   - The previous cycle ended with a non-negative final balance (no debt).
--
-- Algorithm:
--   if p_cycle is the first cycle of the member → 0
--   prev := the cycle with cycle_number = p_cycle.cycle_number − 1, same member
--   if prev IS NULL or prev.status = 'settled' → 0
--   prev_balance := daily × (prev.cycleLength − 1)
--                   − Σ(prev.advances excluding undone)
--                   − compute_opening_balance(member, prev)   (RECURSION)
--   if prev_balance ≥ 0 → 0
--   return −prev_balance
--
-- The recursion bottoms out at cycle_number=1 or a settled cycle. In
-- practice the chain is 1-3 deep; depth is bounded by the number of
-- consecutive unsettled cycles.
--
-- SECURITY DEFINER (per AC #2): the helper bypasses RLS for cross-cycle
-- reads, but enforces ownership via auth.uid() check against the owning
-- collector. SECURITY DEFINER is necessary because consuming RPCs are
-- themselves SECURITY DEFINER — keeping the helper invoker would force
-- a separate plain-SQL ownership trail; DEFINER is simpler and the
-- explicit auth check below is the gate.
--
-- STABLE: pure read; same result within a transaction.
-- ---------------------------------------------------------------------------

create or replace function public.compute_opening_balance(
  p_member_id  uuid,
  p_cycle_id   uuid
) returns bigint
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller            uuid;
  v_member_owner      uuid;
  v_daily_amount      bigint;
  v_cycle_number      integer;
  v_prev              record;
  v_prev_advances     bigint;
  v_prev_opening      bigint;
  v_prev_contrib_days integer;
  v_prev_balance      bigint;
begin
  -- Ownership gate. service_role bypasses (auth.uid() returns null for
  -- service-role JWTs; we accept that for backend callers like sms-worker
  -- which need to read the math layer without an auth context).
  v_caller := auth.uid();

  select collector_id, daily_amount::bigint
    into v_member_owner, v_daily_amount
    from public.members
   where id = p_member_id;
  if v_member_owner is null then
    return 0;
  end if;
  if v_caller is not null and v_member_owner <> v_caller then
    raise exception 'unauthorized: member % is not owned by caller', p_member_id
      using errcode = '28000';
  end if;

  -- Find the current cycle's cycle_number.
  select cycle_number into v_cycle_number
    from public.cycles
   where id = p_cycle_id and member_id = p_member_id;
  if v_cycle_number is null or v_cycle_number <= 1 then
    return 0;
  end if;

  -- Previous cycle = same member, cycle_number − 1.
  select id, status, start_date, end_date
    into v_prev
    from public.cycles
   where member_id = p_member_id and cycle_number = v_cycle_number - 1;
  if v_prev.id is null then
    return 0;
  end if;
  if v_prev.status = 'settled' then
    return 0;
  end if;

  -- Sum previous cycle's advances (excluding soft-undone).
  select coalesce(
           sum(nullif(public.vault_decrypt(amount_encrypted), '')::numeric(12, 0)),
           0
         )::bigint
    into v_prev_advances
    from public.transactions
   where cycle_id = v_prev.id
     and kind = 'advance'
     and undone_at is null;

  -- Recurse: prev's own opening_balance carries forward from ITS predecessor.
  v_prev_opening := public.compute_opening_balance(p_member_id, v_prev.id);

  -- Previous final balance, NFR-R3 mirror of TS computeProjectedFinalBalance.
  v_prev_contrib_days := (v_prev.end_date - v_prev.start_date + 1) - 1;
  v_prev_balance := v_daily_amount * v_prev_contrib_days
                    - v_prev_advances
                    - v_prev_opening;

  if v_prev_balance >= 0 then
    return 0;
  end if;
  return -v_prev_balance;
end;
$$;

comment on function public.compute_opening_balance(uuid, uuid) is
  'Story 12.3 (Q1 Path A): recursive carry-over of unpaid debt from the previous unsettled cycle. Returns the debt amount in F CFA (≥ 0). STABLE + SECURITY DEFINER with explicit ownership check. Mirrors TS computeOpeningBalance — cross-checked by compute-opening-balance.contract.test.ts.';

grant execute on function public.compute_opening_balance(uuid, uuid) to authenticated, service_role;
revoke execute on function public.compute_opening_balance(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 2. record_advance — capacity check now subtracts opening_balance.
--
-- Latest pre-12.3 version: migration 20260519215232_calendar_month_cycle_rpcs.sql
-- line 344 (Story 11.3 — variable-length capacity).
--
-- Δ: v_capacity now subtracts compute_opening_balance(p_member_id, p_cycle_id).
-- All other behaviour preserved byte-for-byte: idempotent replay, motive
-- normalisation, source enum cast, cycle_day [1, 31] ceiling, etc.
--
-- Q2bis enforcement: when opening_balance ≥ daily × contribDays, the
-- capacity is ≤ 0 and every positive new_advance is rejected. Saver
-- must repay via contributions before borrowing again.
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
  v_opening_balance   bigint;
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

  -- Story 11.3 — capacity bound from THIS cycle's own length.
  -- Story 12.3 — capacity additionally subtracts opening_balance (carry-over).
  select c.start_date, c.end_date into v_cycle_start, v_cycle_end
    from public.cycles c where c.id = p_cycle_id;
  if v_cycle_start is null then
    raise exception 'not_found: cycle % does not exist', p_cycle_id using errcode = 'P0002';
  end if;
  v_contribution_days := (v_cycle_end - v_cycle_start + 1) - 1;

  v_opening_balance := public.compute_opening_balance(p_member_id, p_cycle_id);

  select coalesce(sum(amount), 0) into v_existing_total
    from public.transactions_decrypted
   where cycle_id = p_cycle_id and kind = 'advance';

  v_capacity := v_daily_amount * v_contribution_days - v_opening_balance;

  -- Q2bis: when carry-over fills the entire cycle, v_capacity ≤ 0 and
  -- every positive p_amount fails the check below. Message is specific so
  -- the UI can surface the carry-over reason to the collector.
  if v_existing_total + p_amount > v_capacity then
    raise exception 'over_limit: advance exceeds projected available balance (existing=% + new=% > capacity=%; opening_balance=%)',
      v_existing_total, p_amount, v_capacity, v_opening_balance using errcode = '22023';
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
  'Atomic advance insert (Story 5.4 / FR24 + FR25). Story 4.6: motive optional. Story 8.4: idempotent via p_event_id. Story 11.3: capacity = daily × ((end_date − start_date + 1) − 1). Story 12.3: capacity additionally subtracts compute_opening_balance(member, cycle) — carry-over from unsettled previous cycle. When opening_balance ≥ daily × contribDays the capacity is ≤ 0 and all advances are rejected (Q2bis).';

-- ---------------------------------------------------------------------------
-- 3. commit_cycle_settlement — payout subtracts opening_balance.
--
-- Latest pre-12.3 version: migration 20260519215232 line 239 (Story 11.3).
--
-- Δ: v_computed_payout now subtracts compute_opening_balance(p_member_id, p_cycle_id).
-- The NFR-R3 cross-check against p_expected_payout means the CLIENT
-- (members/[id].settlement.tsx) MUST also subtract opening_balance via
-- the TS settle() helper updated in the same PR. Tested by the existing
-- commit-cycle-settlement.contract.test.ts plus a new scenario for a
-- non-zero carry-over.
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
  v_opening_balance   bigint;
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
  -- Story 12.3 — payout additionally subtracts opening_balance carry-over.
  v_cycle_length := (v_cycle.end_date - v_cycle.start_date) + 1;
  v_contribution_days := v_cycle_length - 1;

  select coalesce(sum(public.vault_decrypt(t.amount_encrypted)::numeric(12, 0)), 0)::bigint
    into v_advances_sum
    from public.transactions t
   where t.cycle_id = p_cycle_id and t.kind = 'advance' and t.undone_at is null;

  v_opening_balance := public.compute_opening_balance(p_member_id, p_cycle_id);

  v_computed_payout := (v_member.daily_amount::bigint * v_contribution_days)
                       - v_advances_sum
                       - v_opening_balance;

  -- NFR-R3 zero-tolerance cross-check.
  if v_computed_payout <> p_expected_payout then
    raise exception 'cycle_settlement: payout mismatch (client=%s, server=%s)',
                    p_expected_payout, v_computed_payout
      using errcode = 'P0002',
            detail = format('client_payout=%s server_payout=%s opening_balance=%s',
                            p_expected_payout, v_computed_payout, v_opening_balance);
  end if;

  v_amount_secret := public.vault_encrypt(v_computed_payout::text);

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
  'Atomic settlement commit (Story 7.4 / FR21 / NFR-R3). Story 11.3: payout from THIS cycle''s length. Story 12.3: payout additionally subtracts compute_opening_balance — the carry-over from the previous unsettled cycle. Client TS settle() must mirror exactly or the NFR-R3 cross-check fires.';

-- ---------------------------------------------------------------------------
-- 4. format_sms_body — receipt SMS projected balance subtracts opening_balance.
--
-- Latest pre-12.3 version: migration 20260520015808 (Story 11.4 — dynamic
-- denominator).
--
-- Δ: v_projected now subtracts compute_opening_balance for the
-- first_receipt + subsequent_receipt branches. The settlement, dispute_ack,
-- and opt_out_confirmation branches are preserved byte-for-byte.
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
  v_cycle_length    integer;
  v_contribution_days integer;
  v_opening_balance bigint;
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

    -- Story 11.4 — `v_cycle_length` drives the printed denominator.
    -- Story 12.3 — projected balance also subtracts opening_balance carry-over.
    select c.start_date, c.end_date into v_cycle_start, v_cycle_end
      from public.cycles c where c.id = v_tx.cycle_id;
    v_cycle_length := (v_cycle_end - v_cycle_start + 1);
    v_contribution_days := v_cycle_length - 1;
    v_opening_balance := public.compute_opening_balance(v_tx.member_id, v_tx.cycle_id);
    v_projected := v_member.daily_amount * v_contribution_days - v_advances_sum - v_opening_balance;
    v_projected_str := replace(to_char(v_projected, 'FM999G999G999'), ',', ' ');

    if p_template_key = 'first_receipt' then
      return format(
        'Bonjour %s. Recu SafariCash: %s FCFA, jour %s/%s. Solde projete fin de cycle: %s FCFA. Detail: %s. SafariCash est un journal d''epargne et non une banque. Repondez STOP pour ne plus recevoir.',
        v_prenom, v_amount_str, v_tx.cycle_day, v_cycle_length, v_projected_str, v_url
      );
    else
      return format(
        'SafariCash. %s FCFA recu, jour %s/%s. Solde projete: %s FCFA. Detail: %s.',
        v_amount_str, v_tx.cycle_day, v_cycle_length, v_projected_str, v_url
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
  'Story 11.4: receipt SMS denominator follows THIS cycle''s actual length. Story 12.3: projected balance (first_receipt + subsequent_receipt) now subtracts compute_opening_balance — carry-over from previous unsettled cycle. settlement/dispute_ack/opt_out_confirmation templates unchanged.';

grant execute on function public.format_sms_body(text, uuid) to authenticated, service_role;
revoke execute on function public.format_sms_body(text, uuid) from public;

-- ---------------------------------------------------------------------------
-- 5. get_receipt_payload — receipt URL projected balance subtracts opening_balance.
--
-- Latest pre-12.3 version: migration 20260519215232 line 786 (Story 11.3).
-- Pure SQL function (not plpgsql). Calling a STABLE plpgsql helper from a
-- SQL function is supported; the planner inlines/treats it conservatively.
--
-- Δ: projected_balance now subtracts compute_opening_balance(t.member_id, t.cycle_id).
-- The return shape (column list + types) is UNCHANGED — Cloudflare Worker
-- consuming this RPC does not need to be re-coded. We deliberately do not
-- expose the opening_balance as a separate column at MVP (deferred per
-- spec § "Out of scope") — the saver sees the net projected balance, no
-- need to surface the carry-over breakdown on the receipt page.
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
stable
set search_path = public, pg_temp
as $$
  select
    nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount,
    t.kind::text,
    t.cycle_day,
    t.created_at,
    substring(unaccent(public.vault_decrypt(m.name_encrypted)) from '^[^ ]+') as member_first_name,
    -- Story 11.3 — projected balance from THIS cycle's contributionDays.
    -- Story 12.3 — additionally subtract compute_opening_balance carry-over.
    ((m.daily_amount * ((c.end_date - c.start_date + 1) - 1))
     - coalesce(
         (
           select sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0))
             from public.transactions t2
            where t2.cycle_id = t.cycle_id
              and t2.kind = 'advance'
              and t2.undone_at is null
         ),
         0
       )
     - public.compute_opening_balance(t.member_id, t.cycle_id)
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
  'Story 11.3: projected_balance from joined cycle row''s length. Story 12.3: projected_balance additionally subtracts compute_opening_balance — carry-over from previous unsettled cycle. Return shape unchanged so the Cloudflare Worker (workers/receipt-url/) consumes the same column list without code change.';

grant execute on function public.get_receipt_payload(text) to service_role;
revoke execute on function public.get_receipt_payload(text) from public;
revoke execute on function public.get_receipt_payload(text) from authenticated;
