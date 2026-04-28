-- Story 6.3 — Migration 0042: replace enqueue_sms_on_transaction trigger
-- to render the real template body via format_sms_body() instead of the
-- Story 6.1 STUB literal.
--
-- The function body is byte-for-byte identical to the Story 6.1 baseline
-- (migration 0035, 20260427000004_enqueue_sms_template_key.sql) EXCEPT
-- the body line that was `'[STUB] Transaction enregistrée'` is replaced
-- with `public.format_sms_body(v_template_key, new.id)`. Mirroring Story
-- 6.2's audit-allowlist diff discipline: ANY OTHER DRIFT (whitespace,
-- variable rename) is forbidden — the trigger ordering / sms_opt_out
-- placeholder / template_key picking logic stays identical.
--
-- Trigger ordering on public.transactions UNCHANGED:
--   1. BEFORE INSERT: reject_transaction_on_closed_cycle (Story 3.4)
--   2. (INSERT)
--   3. AFTER INSERT: audit_transactions (Story 1.2/3.3/4.5)
--   4. AFTER INSERT: enqueue_sms_on_transaction (THIS)
--   5. AFTER INSERT: promote_cycle_on_advance_trigger (Story 3.3)
--
-- See: _bmad-output/implementation-artifacts/6-3-sms-copy-templates.md AC #10.

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
begin
  if new.kind not in ('contribution', 'rattrapage', 'advance') then
    return null;
  end if;

  -- Story 6.5 placeholder — will check members.sms_opt_out when the
  -- column lands. Keep the structural slot so 6.5 only changes the
  -- boolean expression, not the trigger structure.
  if false then
    -- Story 6.5: if v_member.sms_opt_out then return null; end if;
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
  'AFTER INSERT trigger on transactions. Story 6.3 — calls format_sms_body() to render the real first_receipt / subsequent_receipt body (replaces the Story 6.1 STUB literal). Story 6.5 will wire the sms_opt_out check (placeholder IF FALSE block).';

revoke execute on function public.enqueue_sms_on_transaction() from public;
