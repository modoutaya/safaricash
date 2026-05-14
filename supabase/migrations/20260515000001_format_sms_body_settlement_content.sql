-- Story 7.5 — Migration 0062: extend format_sms_body's 'settlement' branch.
--
-- Baseline: migration 0041 (20260429000002_format_sms_body.sql, Story 6.3).
-- Story 7.5 rewrites ONLY the settlement-branch body to include the saver's
-- first name + the cycle date range + a closing statement, per BDD line
-- 1163. Stays GSM-7 single-SMS (≤ 160 chars) by unaccenting the name,
-- omitting the year in the SMS dates, and skipping the NBSP thousands
-- separator on the amount. The receipt URL page (Worker, Story 6.4 + 7.5)
-- shows the formatted version with full DD/MM/YYYY and grouped amount.
--
-- Diff vs. baseline is INTENTIONALLY MINIMAL:
--   - Added two new local variables (v_cycle_start_str, v_cycle_end_str).
--   - Replaced the settlement-branch return body (lines 120-126 of 0041).
-- Other branches (first_receipt / subsequent_receipt / dispute_ack), the
-- function signature, search_path, SECURITY DEFINER marker, GRANT EXECUTE
-- — UNCHANGED.
--
-- Length budget — exact computation (default URL base 'https://safaricash.app/r'):
--   Literals: 'SafariCash. ' (12) + ', votre cycle du ' (17) + ' au ' (4) +
--             ' est clos. ' (11) + 'Vous avez recu ' (15) +
--             ' FCFA. Detail: ' (15) + '.' (1) = 75
--   + firstName cap 9 + dates 5+5 + amount 9 (worst-case 9-digit) +
--     URL 57 (24 base + 33 path) = 160 chars EXACTLY.
-- Story 7.5 code-review patch #1 — Story 7.5 first draft missed
-- 'Merci. ' (7 chars) in the count and over-capped firstName at 16,
-- producing 162-167 chars worst-case. Fix: drop 'Merci. ' from the
-- template AND cap firstName at 9 (matches typical Senegalese names).
-- The length contract test 3b uses "Mahamadou" (9 chars) + 9-digit
-- amount to lock down the worst case.
--
-- See: _bmad-output/implementation-artifacts/7-5-cycle-settled-final-sms.md AC #1.

set check_function_bodies = off;

create or replace function public.format_sms_body(
  p_template_key  text,
  p_transaction_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  -- Story 7.5 — new locals for the settlement-branch dates.
  v_cycle_start_str text;
  v_cycle_end_str   text;
begin
  if p_template_key not in ('first_receipt', 'subsequent_receipt', 'settlement', 'dispute_ack') then
    raise exception 'invalid_template_key: % is not a recognised template', p_template_key
      using errcode = '22000';
  end if;

  -- Fetch transaction + decrypted amount.
  select t.id, t.member_id, t.cycle_id, t.kind, t.cycle_day, t.receipt_token,
         nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount
    into v_tx
    from public.transactions t
   where t.id = p_transaction_id;

  if v_tx.id is null then
    raise exception 'transaction_not_found: % does not exist', p_transaction_id
      using errcode = 'P0002';
  end if;

  v_amount := v_tx.amount;

  -- Receipt URL base (Story 6.4 hand-off).
  v_url_base := coalesce(
    nullif(current_setting('app.receipt_url_base', true), ''),
    'https://safaricash.app/r'
  );
  v_url := v_url_base || '/' || v_tx.receipt_token;

  -- Format amount with ASCII-space thousands separators (Postgres default
  -- is comma; replace to align with French SMS convention).
  v_amount_str := replace(to_char(v_amount, 'FM999G999G999'), ',', ' ');

  if p_template_key = 'first_receipt' or p_template_key = 'subsequent_receipt' then
    -- Decrypt + sanitise member name → first token, unaccent, truncate to 16.
    select unaccent(public.vault_decrypt(m.name_encrypted)) as full_name,
           m.daily_amount
      into v_member
      from public.members m
     where m.id = v_tx.member_id;

    v_prenom := substring(coalesce(split_part(v_member.full_name, ' ', 1), 'Saver') from 1 for 16);
    if v_prenom = '' then v_prenom := 'Saver'; end if;

    -- Advances on this cycle (excludes soft-undone rows; mirrors the
    -- cycleEngine `dailyAmount * 29 - sum(advances)` formula).
    select coalesce(sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0)), 0)
      into v_advances_sum
      from public.transactions t2
     where t2.cycle_id = v_tx.cycle_id
       and t2.kind = 'advance'
       and t2.undone_at is null;

    v_projected := v_member.daily_amount * 29 - v_advances_sum;
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
    -- Story 7.5 — settlement SMS receives the saver's first name + cycle
    -- date range (per BDD line 1163). GSM-7 single-SMS discipline:
    -- unaccent the name, cap firstName at 9 chars (typical Senegalese
    -- names + worst-case 9-digit amount = exactly 160 chars), omit the
    -- year (DD/MM only), use plain digits (no NBSP) for the amount.
    -- Closing statement deferred to the Worker receipt page (longer
    -- "Merci de votre confiance..." copy) to keep the SMS in single-SMS.
    select unaccent(public.vault_decrypt(m.name_encrypted)) as full_name
      into v_member
      from public.members m
     where m.id = v_tx.member_id;

    -- Code-review patch #1 — cap at 9 (was 16; combined with the removed
    -- 'Merci. ' suffix this puts the worst-case body at exactly 160 chars).
    v_prenom := substring(coalesce(split_part(v_member.full_name, ' ', 1), 'Saver') from 1 for 9);
    if v_prenom = '' then v_prenom := 'Saver'; end if;

    select to_char(c.start_date, 'DD/MM'), to_char(c.end_date, 'DD/MM')
      into v_cycle_start_str, v_cycle_end_str
      from public.cycles c
     where c.id = v_tx.cycle_id;

    -- Code-review patch #1 — 'Merci. ' removed (7 chars saved) so the
    -- template fits under the 160-char single-SMS cap at worst case
    -- (firstName 9 + 9-digit amount + 32-hex token + default URL prefix).
    return format(
      'SafariCash. %s, votre cycle du %s au %s est clos. Vous avez recu %s FCFA. Detail: %s.',
      v_prenom, v_cycle_start_str, v_cycle_end_str,
      to_char(v_amount, 'FM999999999'), v_url
    );
  end if;

  -- p_template_key = 'dispute_ack'
  -- Dispute reference = first 8 chars of the most recent disputes.id for
  -- this transaction (Story 10.2 will wire the row creation).
  select substring(d.id::text from 1 for 8)
    into v_dispute_ref
    from public.disputes d
   where d.transaction_id = p_transaction_id
   order by d.flagged_at desc
   limit 1;

  if v_dispute_ref is null then
    -- Defensive — Story 10.2 should always create a disputes row before
    -- calling format_sms_body('dispute_ack', ...). Fall back to a stable
    -- placeholder rather than NULL-leaking into the SMS body.
    v_dispute_ref := 'pending';
  end if;

  return format(
    'SafariCash. Votre signalement a ete recu. Reponse sous 48h. Reference: %s.',
    v_dispute_ref
  );
end;
$$;

comment on function public.format_sms_body(text, uuid) is
  'Story 7.5 — settlement branch extended with first name + cycle date range (closing statement moved to the Worker receipt page to preserve the 160-char single-SMS cap); Story 6.3 baseline preserved for receipt + dispute templates. ASCII-only output via unaccent(); banking language linter-enforced. Composes receipt URL via current_setting(''app.receipt_url_base'') + receipt_token.';

-- Code-review patch #4 — re-declare grants explicitly (CREATE OR REPLACE
-- preserves existing grants, but re-stating them keeps the migration self-
-- contained for db:reset cycles and removes ambiguity for future readers.
grant execute on function public.format_sms_body(text, uuid) to authenticated;
grant execute on function public.format_sms_body(text, uuid) to service_role;
revoke execute on function public.format_sms_body(text, uuid) from public;
