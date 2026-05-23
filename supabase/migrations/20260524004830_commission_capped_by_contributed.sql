-- 2026-05-24 — commission is min(contributedTotal, dailyAmount), not flat
-- dailyAmount. Business rule (pilot feedback): no cotisation ⇒ no
-- commission. Pre-change formula billed the full daily-amount upfront
-- regardless of what the saver had actually cotisé, producing alarming
-- negative running balances on freshly-opened cycles (e.g. day 3 of 10
-- with 0 contributions showed −2 000 FCFA in the members-list card).
--
--   NEW formula (this migration):
--     commission = LEAST(contributedTotal, dailyAmount)
--     payout     = contributedTotal − commission − Σadvances − opening_balance
--
--   OLD formula (Story 12.5 PR A migration 20260521190728):
--     payout     = contributedTotal − dailyAmount − Σadvances − opening_balance
--
-- The two formulas are mathematically equivalent when contributedTotal
-- ≥ dailyAmount. They differ only when the saver hasn't yet cotisé a
-- full day's worth — in that case the new formula caps the commission
-- at what was actually cotisé (saver owes zero commission upfront).
--
-- 3 functions touched, all in lockstep (NFR-R3 zero-tolerance — the TS
-- settle() / computeCurrentBalance() in src/domain/cycle/cycleEngine.ts
-- must produce byte-identical values):
--
--   1. commit_cycle_settlement — actual payout commit (Story 7.4)
--   2. format_sms_body         — "Solde projete" line in receipt SMS
--   3. get_receipt_payload     — projected_balance column read by the
--                                Cloudflare receipt-url worker
--
-- Latest pre-change versions:
--   - commit_cycle_settlement: 20260521190728_settle_uses_contributed_total.sql
--   - format_sms_body / get_receipt_payload:
--     20260521230247_sms_receipt_projected_uses_contributed_total.sql

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. commit_cycle_settlement — actual payout, NFR-R3 cross-checked with TS.
-- ---------------------------------------------------------------------------

create or replace function public.commit_cycle_settlement(
  p_member_id        uuid,
  p_cycle_id         uuid,
  p_expected_payout  bigint
)
returns table (
  settlement_transaction_id  uuid,
  settled_payout             bigint,
  settled_at                 timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id        uuid;
  v_cycle               public.cycles%rowtype;
  v_member              public.members%rowtype;
  v_cycle_length        integer;
  v_advances_sum        bigint;
  v_contributed_total   bigint;
  v_commission          bigint;
  v_opening_balance     bigint;
  v_computed_payout     bigint;
  v_amount_secret       uuid;
  v_tx_id               uuid;
  v_settled_at          timestamptz;
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

  v_cycle_length := (v_cycle.end_date - v_cycle.start_date) + 1;

  select coalesce(sum(public.vault_decrypt(t.amount_encrypted)::numeric(12, 0)), 0)::bigint
    into v_contributed_total
    from public.transactions t
   where t.cycle_id = p_cycle_id
     and t.kind in ('contribution', 'rattrapage')
     and t.undone_at is null;

  select coalesce(sum(public.vault_decrypt(t.amount_encrypted)::numeric(12, 0)), 0)::bigint
    into v_advances_sum
    from public.transactions t
   where t.cycle_id = p_cycle_id and t.kind = 'advance' and t.undone_at is null;

  v_opening_balance := public.compute_opening_balance(p_member_id, p_cycle_id);

  -- 2026-05-24 — commission capped at what was actually cotisé.
  -- LEAST is PostgreSQL's min(). Mirrors TS Math.min(contributedTotal, dailyAmount).
  v_commission := least(v_contributed_total, v_member.daily_amount::bigint);
  v_computed_payout := v_contributed_total - v_commission - v_advances_sum - v_opening_balance;

  if v_computed_payout <> p_expected_payout then
    raise exception 'cycle_settlement: payout mismatch (client=%s, server=%s)',
                    p_expected_payout, v_computed_payout
      using errcode = 'P0002',
            detail = format(
              'client_payout=%s server_payout=%s contributed_total=%s commission=%s advances=%s opening_balance=%s',
              p_expected_payout, v_computed_payout, v_contributed_total,
              v_commission, v_advances_sum, v_opening_balance
            );
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
  '2026-05-24: commission capped at LEAST(contributed_total, daily_amount) — saver never owes pre-paid commission on a fresh cycle. Mirrors TS settle() byte-for-byte (NFR-R3).';

-- ---------------------------------------------------------------------------
-- 2. format_sms_body — "Solde projete" line in receipt SMS.
-- ---------------------------------------------------------------------------

create or replace function public.format_sms_body(p_template_key text, p_transaction_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_tx                  record;
  v_member              record;
  v_advances_sum        numeric(12, 0);
  v_contributed_total   numeric(12, 0);
  v_commission          numeric(12, 0);
  v_amount              numeric(12, 0);
  v_projected           numeric(12, 0);
  v_url_base            text;
  v_url                 text;
  v_prenom              text;
  v_amount_str          text;
  v_projected_str       text;
  v_dispute_ref         text;
  v_cycle_start_str     text;
  v_cycle_end_str       text;
  v_cycle_start         date;
  v_cycle_end           date;
  v_cycle_length        integer;
  v_opening_balance     bigint;
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

    select coalesce(sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0)), 0)
      into v_contributed_total
      from public.transactions t2
     where t2.cycle_id = v_tx.cycle_id
       and t2.kind in ('contribution', 'rattrapage')
       and t2.undone_at is null;

    select c.start_date, c.end_date into v_cycle_start, v_cycle_end
      from public.cycles c where c.id = v_tx.cycle_id;
    v_cycle_length := (v_cycle_end - v_cycle_start + 1);
    v_opening_balance := public.compute_opening_balance(v_tx.member_id, v_tx.cycle_id);

    -- 2026-05-24 — commission = min(contributed, daily). Same change as
    -- commit_cycle_settlement; SMS receipt's projected line must match.
    v_commission := least(v_contributed_total, v_member.daily_amount);
    v_projected := v_contributed_total - v_commission - v_advances_sum - v_opening_balance;
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

grant execute on function public.format_sms_body(text, uuid) to authenticated, service_role;
revoke execute on function public.format_sms_body(text, uuid) from public;

comment on function public.format_sms_body(text, uuid) is
  '2026-05-24: receipt SMS "Solde projete" uses commission = LEAST(contributed, daily) — matches TS computeCurrentBalance and commit_cycle_settlement.';

-- ---------------------------------------------------------------------------
-- 3. get_receipt_payload — projected_balance column for the receipt-url worker.
-- ---------------------------------------------------------------------------

drop function if exists public.get_receipt_payload(text);

create function public.get_receipt_payload(p_token text)
returns table (
  amount              numeric(12, 0),
  kind                text,
  cycle_day           integer,
  created_at          timestamptz,
  member_first_name   text,
  projected_balance   numeric(12, 0),
  daily_amount        bigint,
  cycle_start_date    date,
  cycle_end_date      date,
  anonymised_at       timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  -- 2026-05-24 — projected_balance uses commission = min(contributed, daily).
  -- Using `greatest(contributed - daily, 0)` as the SQL equivalent of
  -- `contributed - min(contributed, daily)` so we don't need to alias the
  -- contributed subquery twice.
  with src as (
    select
      t.cycle_id,
      t.cycle_day,
      t.created_at,
      t.kind,
      t.amount_encrypted,
      t.member_id,
      coalesce(
        (
          select sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0))
            from public.transactions t2
           where t2.cycle_id = t.cycle_id
             and t2.kind in ('contribution', 'rattrapage')
             and t2.undone_at is null
        ),
        0
      ) as contributed_total,
      coalesce(
        (
          select sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0))
            from public.transactions t2
           where t2.cycle_id = t.cycle_id
             and t2.kind = 'advance'
             and t2.undone_at is null
        ),
        0
      ) as advances_sum
    from public.transactions t
    where t.receipt_token = p_token
      and t.undone_at is null
  )
  select
    nullif(public.vault_decrypt(src.amount_encrypted), '')::numeric(12, 0) as amount,
    src.kind::text,
    src.cycle_day,
    src.created_at,
    substring(unaccent(public.vault_decrypt(m.name_encrypted)) from '^[^ ]+') as member_first_name,
    (
      src.contributed_total
      - least(src.contributed_total, m.daily_amount)
      - src.advances_sum
      - public.compute_opening_balance(src.member_id, src.cycle_id)
    ) as projected_balance,
    m.daily_amount,
    c.start_date as cycle_start_date,
    c.end_date   as cycle_end_date,
    m.anonymised_at
  from src
  join public.members m on m.id = src.member_id
  join public.cycles  c on c.id = src.cycle_id;
$$;

comment on function public.get_receipt_payload(text) is
  '2026-05-24: projected_balance uses commission = LEAST(contributed, daily) — matches TS computeCurrentBalance and commit_cycle_settlement.';
