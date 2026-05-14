-- Story 7.4 — Migration 0060: extend enqueue_sms_on_transaction to force
-- template_key='settlement' for kind='settlement'.
--
-- Baseline: migration 0045 (20260501000002_enqueue_sms_optout_check.sql).
-- Story 7.4 adds 'settlement' to the kind allow-list AND forces the
-- template_key when kind='settlement' (bypasses the first_receipt /
-- subsequent_receipt picker since the settlement is its own template).
--
-- Diff vs. baseline is intentionally minimal:
--   - kind allow-list extended with 'settlement'.
--   - template_key picker gets a leading IF for kind='settlement'.
--   - Comment line updated.
-- Trigger ordering, SECURITY DEFINER discipline, search_path, opt-out
-- short-circuit, phone-lookup, format_sms_body call — UNCHANGED.
--
-- The existing format_sms_body('settlement', new.id) returns:
--   'SafariCash. Cycle clos. Vous avez recu %s FCFA. Merci. Detail: %s.'
-- (migration 0029 line 120). Story 7.5 may refine the template content
-- (member name, cycle date range) but Story 7.4 trusts the existing copy.
--
-- See: _bmad-output/implementation-artifacts/7-4-settlement-reauth-gate.md AC #3.

set check_function_bodies = off;

create or replace function public.enqueue_sms_on_transaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone        text;
  v_template_key text;
  v_prior_count  int;
  v_opt_out      boolean;
begin
  -- Story 7.4 — 'settlement' joins the allow-list so the settlement
  -- transaction inserted by commit_cycle_settlement fires this trigger.
  if new.kind not in ('contribution', 'rattrapage', 'advance', 'settlement') then
    return null;
  end if;

  -- Story 6.5 — real opt-out short-circuit. Replaces the IF FALSE
  -- placeholder shipped by Stories 6.1 / 6.3.
  select sms_opt_out
    into v_opt_out
    from public.members
   where id = new.member_id;
  if v_opt_out then
    return null;
  end if;

  -- Decrypt the saver's phone via the existing vault_decrypt helper.
  select coalesce(public.vault_decrypt(phone_number_encrypted), '')
    into v_phone
    from public.members
   where id = new.member_id;

  -- Skip when the saver has no phone on file (cash-only path).
  if v_phone is null or trim(v_phone) = '' then
    return null;
  end if;

  -- Story 7.4 — kind='settlement' forces template_key='settlement'
  -- regardless of prior SMS count. The settlement template is its own
  -- semantic surface (cycle-clos copy), not a transaction-recap.
  if new.kind = 'settlement' then
    v_template_key := 'settlement';
  else
    -- Pre-Story-7.4 picker: first_receipt for the saver's first SMS,
    -- subsequent_receipt thereafter.
    select count(*)
      into v_prior_count
      from public.sms_queue sq
      join public.transactions t on t.id = sq.transaction_id
     where t.member_id = new.member_id;

    v_template_key := case when v_prior_count = 0 then 'first_receipt' else 'subsequent_receipt' end;
  end if;

  insert into public.sms_queue (
    collector_id, transaction_id, recipient_phone, body, status,
    template_key, retry_count
  ) values (
    new.collector_id,
    new.id,
    v_phone,
    -- Story 6.3 replaced the STUB literal with the rendered template body.
    -- For kind='settlement', format_sms_body('settlement', new.id) renders
    -- the existing migration 0029 copy.
    public.format_sms_body(v_template_key, new.id),
    'queued',
    v_template_key,
    0
  );

  return null;
end;
$$;

comment on function public.enqueue_sms_on_transaction() is
  'AFTER INSERT trigger on transactions. Story 7.4 — kind=''settlement'' joins the allow-list and forces template_key=''settlement'' regardless of prior SMS count. Story 6.5 — wired the real members.sms_opt_out short-circuit. Story 6.3 — calls format_sms_body() to render the real body.';

revoke execute on function public.enqueue_sms_on_transaction() from public;
