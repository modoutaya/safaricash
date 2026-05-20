-- Story 11.4 — dynamic SMS denominator (calendar-month cycle length).
--
-- The two saver-facing receipt SMS templates (`first_receipt`,
-- `subsequent_receipt`) printed a hardcoded "/30" denominator regardless
-- of the actual cycle length. With Story 11.3 the cycle is calendar-month
-- aligned and therefore variable (28/29/30/31 — or partial on a first
-- enrolment, down to MIN_CYCLE_LENGTH_DAYS = 3). A saver enrolled on the
-- 7th of a 30-day month sees a 24-day cycle and the SMS must read
-- "jour 1/24", not "jour 1/30".
--
-- Only the two `format()` calls change. The projected-balance derivation
-- (Story 11.3 — `v_contribution_days = (end − start + 1) − 1`) is left
-- intact; `v_cycle_length = (end − start + 1)` is introduced as a new
-- local so the same cycle row read drives both numbers. The
-- `opt_out_confirmation` / `settlement` / `dispute_ack` branches are
-- preserved byte-for-byte from migration 20260519215232 (Story 11.3).
--
-- CREATE OR REPLACE on the exact same `(text, uuid)` signature replaces
-- the prior body in place — no DROP needed (PG resolves the overload).

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

    -- Story 11.4 — `v_cycle_length` drives the printed denominator. Story
    -- 11.3 — projected balance still uses THIS cycle's own contribution
    -- days (= cycleLength − 1), mirroring computeProjectedFinalBalance.
    select c.start_date, c.end_date into v_cycle_start, v_cycle_end
      from public.cycles c where c.id = v_tx.cycle_id;
    v_cycle_length := (v_cycle_end - v_cycle_start + 1);
    v_contribution_days := v_cycle_length - 1;
    v_projected := v_member.daily_amount * v_contribution_days - v_advances_sum;
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
  'Story 11.4: receipt SMS denominator now follows THIS cycle''s actual length (= end_date − start_date + 1), variable per calendar month. Story 11.3 projected-balance math unchanged. Story 10.5 opt_out_confirmation + Story 7.5 settlement + Story 10.2 dispute_ack templates preserved.';

grant execute on function public.format_sms_body(text, uuid) to authenticated, service_role;
revoke execute on function public.format_sms_body(text, uuid) from public;
