-- Story 6.5 — Migration 0045: replace IF FALSE placeholder with the real
-- members.sms_opt_out check.
--
-- Re-derived from Story 6.3 baseline (migration 0042,
-- 20260429000003_enqueue_sms_format_body.sql). Diff is intentionally
-- minimal: replace the structural `IF FALSE THEN ... END IF` block with
-- the real lookup + short-circuit. Trigger ordering / SECURITY DEFINER /
-- search_path / template_key picking / format_sms_body call — UNCHANGED.
--
-- See: _bmad-output/implementation-artifacts/6-5-first-sms-consent-optout.md AC #2 / #10.

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
  if new.kind not in ('contribution', 'rattrapage', 'advance') then
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

  -- Pick template_key: first_receipt if no prior sms_queue row for any
  -- transaction belonging to this member; subsequent_receipt otherwise.
  -- The query joins via transactions.member_id (sms_queue itself has no
  -- member_id column).
  select count(*)
    into v_prior_count
    from public.sms_queue sq
    join public.transactions t on t.id = sq.transaction_id
   where t.member_id = new.member_id;

  v_template_key := case when v_prior_count = 0 then 'first_receipt' else 'subsequent_receipt' end;

  insert into public.sms_queue (
    collector_id, transaction_id, recipient_phone, body, status,
    template_key, retry_count
  ) values (
    new.collector_id,
    new.id,
    v_phone,
    -- Story 6.3 replaced the STUB literal with the rendered template body.
    public.format_sms_body(v_template_key, new.id),
    'queued',
    v_template_key,
    0
  );

  return null;
end;
$$;

comment on function public.enqueue_sms_on_transaction() is
  'AFTER INSERT trigger on transactions. Story 6.5 — wired the real members.sms_opt_out short-circuit (replaces Story 6.1''s IF FALSE placeholder). Story 6.3 — calls format_sms_body() to render the real first_receipt / subsequent_receipt body.';

revoke execute on function public.enqueue_sms_on_transaction() from public;
