-- Story 6.3 — Migration 0041: format_sms_body SQL helper.
--
-- Renders the saver-facing SMS body for one of four templates:
--   first_receipt        — long form, 2 SMS segments (UX-DR14)
--   subsequent_receipt   — short form, 1 SMS segment (UX-DR15)
--   settlement           — cycle-close notice, 1 segment (UX-DR16)
--   dispute_ack          — 24-48h response promise, 1 segment (UX-DR17)
--
-- All templates ship in 7-bit-ASCII / GSM-7-safe form (NFR-A6); accented
-- decoded names are normalised via unaccent(). NFR-S10 forbids banking
-- language — verified by the banking-language linter test.
--
-- The receipt URL is composed from `current_setting('app.receipt_url_base',
-- true)` + the transaction's receipt_token (Story 6.4 ships the Cloudflare
-- Worker that resolves /r/<token>). Default base is set on the database;
-- per-environment overrides via supabase secrets / ALTER DATABASE.
--
-- See: _bmad-output/implementation-artifacts/6-3-sms-copy-templates.md
--      AC #2, #3, #4, #5, #6, #7, #9, #11.

set check_function_bodies = off;

create extension if not exists unaccent;

-- The receipt URL base is read at function-call time via
-- current_setting('app.receipt_url_base', true) with a literal fallback
-- to 'https://safaricash.app/r'. Per-environment overrides happen via
-- supabase secrets / a deployment-time `ALTER DATABASE ... SET ...`
-- (requires superuser; not part of this migration since the migration
-- role lacks ALTER DATABASE on managed Supabase).

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
  v_tx           record;
  v_member       record;
  v_advances_sum numeric(12, 0);
  v_amount       numeric(12, 0);
  v_projected    numeric(12, 0);
  v_url_base     text;
  v_url          text;
  v_prenom       text;
  v_amount_str   text;
  v_projected_str text;
  v_dispute_ref  text;
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
    -- Settlement total is the transaction's own amount (Story 7.5 will
    -- create a transaction row for the settlement payout).
    return format(
      'SafariCash. Cycle clos. Vous avez recu %s FCFA. Merci. Detail: %s.',
      v_amount_str, v_url
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
  'Story 6.3 / FR27 / NFR-A6 / NFR-S10 — renders 1 of 4 saver-facing SMS bodies (first_receipt / subsequent_receipt / settlement / dispute_ack) for a given transaction. ASCII-only output via unaccent(); banking language is forbidden (linter-enforced). Composes receipt URL via current_setting(''app.receipt_url_base'') + receipt_token.';

grant execute on function public.format_sms_body(text, uuid) to authenticated;
grant execute on function public.format_sms_body(text, uuid) to service_role;
revoke execute on function public.format_sms_body(text, uuid) from public;
