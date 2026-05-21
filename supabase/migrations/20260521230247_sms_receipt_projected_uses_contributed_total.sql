-- Story 12.5 PR C — align format_sms_body + get_receipt_payload's
-- "projected balance" with the actual current cumul (the new model).
--
-- Pre-12.5 (= Phase A migration 20260521084835):
--   projected = dailyAmount × contributionDays − Σadvances − opening_balance
-- assumed the saver versés daily × contribDays every cycle.
--
-- Story 12.5 PR A corrected the SETTLE math; PR B corrected the ADVANCE
-- cap; PR C now corrects the SAVER-FACING "projected" line in the
-- receipt SMS + receipt URL page to reflect actual cumul:
--
--   projected = contributedTotal − dailyAmount − Σadvances − opening_balance
--
-- (= same as TS computeCurrentBalance + settle())
--
-- This was deferred from PR A's scope reduction because the format_sms_body
-- rewrite needed to preserve Phase A's branch ordering (opt_out_confirmation
-- early-exit, dispute_ack reading from public.disputes) byte-for-byte.
-- Achieved here by copying Phase A's function verbatim and changing ONLY
-- the v_projected assignment.
--
-- The SMS label STILL says "Solde projete" (saver-facing copy change is
-- a separate concern tracked outside Story 12.5). The underlying number
-- is now the correct cumul.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. format_sms_body — projected line uses contributedTotal.
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

    -- Σ advances of this cycle (undone excluded).
    select coalesce(sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0)), 0)
      into v_advances_sum
      from public.transactions t2
     where t2.cycle_id = v_tx.cycle_id and t2.kind = 'advance' and t2.undone_at is null;

    -- Story 12.5 PR C — Σ contributions + rattrapage of this cycle.
    select coalesce(sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0)), 0)
      into v_contributed_total
      from public.transactions t2
     where t2.cycle_id = v_tx.cycle_id
       and t2.kind in ('contribution', 'rattrapage')
       and t2.undone_at is null;

    -- Story 11.4 — cycle_length drives the printed jour-denominator.
    select c.start_date, c.end_date into v_cycle_start, v_cycle_end
      from public.cycles c where c.id = v_tx.cycle_id;
    v_cycle_length := (v_cycle_end - v_cycle_start + 1);
    v_opening_balance := public.compute_opening_balance(v_tx.member_id, v_tx.cycle_id);

    -- Story 12.5 PR C — projected line now reflects the actual cumul
    -- (= currentBalance = what the saver is owed RIGHT NOW), not the
    -- pre-12.5 daily × contribDays projection. SMS label kept as
    -- "Solde projete" pending the saver-facing copy rename.
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
  'Story 12.5 PR C: first_receipt/subsequent_receipt projected line reflects ACTUAL cumul (contributedTotal − daily − advances − opening_balance), not the pre-12.5 contract projection. Other branches preserved byte-for-byte from Phase A.';

-- ---------------------------------------------------------------------------
-- 2. get_receipt_payload — projected_balance column uses contributedTotal.
--    Column return shape unchanged so the Cloudflare worker (workers/receipt-url)
--    consumes the same surface without a code edit.
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
    -- Story 12.5 PR C — projected_balance now reflects actual cumul:
    -- contributedTotal − daily(commission) − advances − opening_balance.
    (
      coalesce(
        (
          select sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0))
            from public.transactions t2
           where t2.cycle_id = t.cycle_id
             and t2.kind in ('contribution', 'rattrapage')
             and t2.undone_at is null
        ),
        0
      )
      - m.daily_amount
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
  'Story 12.5 PR C: projected_balance reflects actual cumul (contributedTotal − daily − advances − opening_balance). Return shape unchanged so workers/receipt-url consumes the same column list.';

grant execute on function public.get_receipt_payload(text) to service_role;
revoke execute on function public.get_receipt_payload(text) from public;
revoke execute on function public.get_receipt_payload(text) from authenticated;
