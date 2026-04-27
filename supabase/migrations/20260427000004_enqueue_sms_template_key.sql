-- Story 6.1 — Migration 0035: replace enqueue_sms_on_transaction trigger
-- to populate template_key + new columns from migration 0034.
--
-- The function picks template_key based on the saver's prior SMS
-- history: 'first_receipt' if NO prior sms_queue row exists for any
-- transaction belonging to NEW.member_id; 'subsequent_receipt' otherwise.
--
-- Story 6.5 will refine this with a `members.first_sms_sent_at` flag +
-- the `members.sms_opt_out` check (placeholder `IF FALSE THEN ...`
-- block below — Story 6.5 will replace FALSE with the real expression).
--
-- Body remains the existing '[STUB] Transaction enregistrée' literal —
-- Story 6.3 will replace this trigger again to render the real template
-- via a format_sms_body(template_key, transaction_id) helper.
--
-- Trigger ordering on public.transactions UNCHANGED:
--   1. BEFORE INSERT: reject_transaction_on_closed_cycle (Story 3.4)
--   2. (INSERT)
--   3. AFTER INSERT: audit_transactions (Story 1.2/3.3/4.5)
--   4. AFTER INSERT: enqueue_sms_on_transaction (THIS)
--   5. AFTER INSERT: promote_cycle_on_advance_trigger (Story 3.3)
--
-- See: epics.md:961-967, _bmad-output/implementation-artifacts/6-1-sms-dispatch-edge-function.md AC #4.

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
    -- STUB body — Story 6.3 will replace this trigger function with
    -- one that renders the real template via a format_sms_body helper.
    '[STUB] Transaction enregistrée',
    'queued',
    v_template_key,
    0
  );

  return null;
end;
$$;

comment on function public.enqueue_sms_on_transaction() is
  'AFTER INSERT trigger on transactions. Story 6.1 — populates template_key (first_receipt / subsequent_receipt) + retry_count from migration 0034. Body is a STUB; Story 6.3 will replace this function to render the real template. Story 6.5 will wire the sms_opt_out check (placeholder IF FALSE block).';

revoke execute on function public.enqueue_sms_on_transaction() from public;

-- Trigger itself is unchanged — same name, same attachment.
-- (CREATE OR REPLACE FUNCTION re-binds the function body without
--  touching the trigger registration.)
