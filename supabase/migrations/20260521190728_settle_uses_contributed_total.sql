-- Story 12.5 — settle formula refactor: payout uses actual contributedTotal.
--
-- Business model correction (pilot feedback 2026-05-21):
-- `daily_amount` is a UX suggestion / saver-set objective, NOT a daily
-- contractual obligation. Savers cotise freely — some days 10 000,
-- some days 3 000, some days 0. The collector returns what was actually
-- versed minus a fixed commission of `daily_amount` minus mid-cycle
-- advances minus any opening_balance debt carried over.
--
--   NEW payout = contributedTotal − dailyAmount − Σadvances − opening_balance
--
-- where contributedTotal = Σ kind ∈ {contribution, rattrapage} amounts
-- booked in the cycle (undone excluded).
--
-- PRE-12.5 formula (replaced):
--   OLD payout = dailyAmount × (cycleLength − 1) − Σadvances − opening_balance
-- assumed the saver paid daily × contribDays every cycle which the
-- founder confirmed was never the actual model in the field.
--
-- Latest pre-12.5 version: migration 20260521084835 (Story 12.3 Phase A).
--
-- This migration ALSO updates `format_sms_body` (first_receipt /
-- subsequent_receipt branches) to use the same actual-contribution math
-- — otherwise the SMS receipt's "Solde projete" line would show the
-- old contract-based projection while the actual payout is different.
-- The user-visible label stays "Solde projete" for this PR (changing
-- the SMS copy is tracked separately) but the underlying value is now
-- the actual current cumul.
--
-- Other Phase A artefacts (record_advance capacity, compute_opening_balance
-- itself) are NOT touched by this migration. PR B of the 12.5 refactor
-- will replace record_advance's capacity check (cap = contributedTotal −
-- advances). PR D will re-evaluate compute_opening_balance under the new
-- model.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. commit_cycle_settlement — new payout formula based on contributedTotal.
--
-- Same idempotency guards, ownership checks, audit emission, sms_queue
-- enqueue, transactions kind='settlement' insert, NFR-R3 cross-check.
-- Only the v_computed_payout assignment changes.
-- ---------------------------------------------------------------------------

create or replace function public.commit_cycle_settlement(
  p_member_id        uuid,
  p_cycle_id         uuid,
  p_expected_payout  bigint
)
returns table (
  transaction_id  uuid,
  settled_payout  bigint,
  settled_at      timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id        uuid;
  v_cycle               record;
  v_member              record;
  v_cycle_length        integer;
  v_advances_sum        bigint;
  v_contributed_total   bigint;
  v_opening_balance     bigint;
  v_computed_payout     bigint;
  v_amount_secret       text;
  v_tx_id               uuid;
  v_settled_at          timestamptz;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'cycle_settlement: missing auth.uid()' using errcode = '42501';
  end if;

  select * into v_cycle from public.cycles where id = p_cycle_id;
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

  -- Story 12.5 — sum actual contributions + rattrapage of THIS cycle.
  -- The collector physically holds this much money for this saver.
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

  -- Story 12.5 — new formula. Mirrors TS settle() exactly.
  v_computed_payout := v_contributed_total
                       - v_member.daily_amount::bigint
                       - v_advances_sum
                       - v_opening_balance;

  -- NFR-R3 zero-tolerance cross-check.
  if v_computed_payout <> p_expected_payout then
    raise exception 'cycle_settlement: payout mismatch (client=%s, server=%s)',
                    p_expected_payout, v_computed_payout
      using errcode = 'P0002',
            detail = format(
              'client_payout=%s server_payout=%s contributed_total=%s commission=%s advances=%s opening_balance=%s',
              p_expected_payout, v_computed_payout, v_contributed_total,
              v_member.daily_amount, v_advances_sum, v_opening_balance
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
  'Story 12.5: atomic settlement commit with NEW formula — payout = contributedTotal − dailyAmount − Σadvances − opening_balance. The pre-12.5 formula assumed daily × contribDays which doesn''t match the cotisation-libre model. Client TS settle() must mirror this exactly or the NFR-R3 cross-check fires.';

-- ---------------------------------------------------------------------------
-- 2. format_sms_body — receipt-template "Solde projete" line aligned with
--    the new payout math. The label stays "Solde projete" for this PR
--    (changing the saver-facing SMS copy is a follow-up); only the
--    underlying number changes to: contributedTotal − daily − advances −
--    opening_balance (the saver's current cumul = what they're owed RIGHT
--    NOW if the cycle settled this instant).
--
-- All other branches (settlement / dispute_ack / opt_out_confirmation) are
-- preserved byte-for-byte from the Phase A version.
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
  v_contribution_days   integer;
  v_opening_balance     numeric(12, 0);
begin
  select t.id, t.amount, t.cycle_id, t.member_id, t.cycle_day, t.receipt_token, t.kind
    into v_tx
    from public.transactions_decrypted t
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

    -- Σ advances of this cycle (undone excluded).
    select coalesce(sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0)), 0)
      into v_advances_sum
      from public.transactions t2
     where t2.cycle_id = v_tx.cycle_id and t2.kind = 'advance' and t2.undone_at is null;

    -- Story 12.5 — Σ contributions + rattrapage of this cycle.
    select coalesce(sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0)), 0)
      into v_contributed_total
      from public.transactions t2
     where t2.cycle_id = v_tx.cycle_id
       and t2.kind in ('contribution', 'rattrapage')
       and t2.undone_at is null;

    select c.start_date, c.end_date into v_cycle_start, v_cycle_end
      from public.cycles c where c.id = v_tx.cycle_id;
    v_cycle_length := (v_cycle_end - v_cycle_start + 1);
    v_contribution_days := v_cycle_length - 1;
    v_opening_balance := public.compute_opening_balance(v_tx.member_id, v_tx.cycle_id);

    -- Story 12.5 — projected line now reflects the actual cumul (= what
    -- the saver is owed RIGHT NOW), not the contract-based projection.
    v_projected := v_contributed_total - v_member.daily_amount - v_advances_sum - v_opening_balance;
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

    v_prenom := substring(coalesce(split_part(v_member.full_name, ' ', 1), 'Saver') from 1 for 16);
    if v_prenom = '' then v_prenom := 'Saver'; end if;

    select c.start_date, c.end_date into v_cycle_start, v_cycle_end
      from public.cycles c where c.id = v_tx.cycle_id;
    v_cycle_start_str := to_char(v_cycle_start, 'DD/MM');
    v_cycle_end_str   := to_char(v_cycle_end,   'DD/MM');

    return format(
      'SafariCash. %s, votre cycle du %s au %s est clos. Vous avez recu %s FCFA. Detail: %s.',
      v_prenom, v_cycle_start_str, v_cycle_end_str, v_amount_str, v_url
    );
  end if;

  if p_template_key = 'dispute_ack' then
    v_dispute_ref := substring(replace(v_tx.id::text, '-', '') from 1 for 8);
    return format(
      'SafariCash. Litige enregistre, ref %s. Reponse sous 48h.',
      v_dispute_ref
    );
  end if;

  if p_template_key = 'opt_out_confirmation' then
    return 'SafariCash. Vous ne recevrez plus de SMS. Pour reactiver, contactez votre collecteur.';
  end if;

  raise exception 'unknown_template_key: %', p_template_key using errcode = 'P0002';
end;
$function$;

grant execute on function public.format_sms_body(text, uuid) to service_role;
revoke execute on function public.format_sms_body(text, uuid) from public;
revoke execute on function public.format_sms_body(text, uuid) from authenticated;

comment on function public.format_sms_body(text, uuid) is
  'Story 12.5: receipt SMS first_receipt/subsequent_receipt "Solde projete" line now reflects the actual cumul (contributedTotal − daily − advances − opening_balance), not the pre-12.5 contract-based projection. settlement / dispute_ack / opt_out_confirmation branches unchanged.';
