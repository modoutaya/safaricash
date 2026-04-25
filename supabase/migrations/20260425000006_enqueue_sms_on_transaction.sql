-- Story 4.3 — Migration 0024: enqueue_sms_on_transaction trigger.
--
-- AFTER INSERT trigger on transactions: when kind ∈ (contribution,
-- rattrapage, advance) AND the member has a non-empty phone, INSERT a
-- row into sms_queue (status=queued) with a STUB body. The body will be
-- REPLACED by Story 6.1 (sms-dispatch) with the real SMS template
-- (amount, projected balance, receipt URL token).
--
-- Members without a phone (cash-only savers) skip the enqueue silently —
-- there's nothing to send.
--
-- Trigger ordering on public.transactions (after this migration lands):
--   1. BEFORE INSERT: reject_transaction_on_closed_cycle (Story 3.4) — gate.
--   2. (INSERT) — happens iff BEFORE didn't raise.
--   3. AFTER INSERT: audit_transactions (Story 1.2) — chain entry.
--   4. AFTER INSERT: enqueue_sms_on_transaction (THIS) — sms_queue row.
--   5. AFTER INSERT: promote_cycle_on_advance_trigger (Story 3.3) — for
--      kind=advance only (cycle status flip).
--
-- See: _bmad-output/implementation-artifacts/4-3-record-contribution-online.md AC #2.

set check_function_bodies = off;

create or replace function public.enqueue_sms_on_transaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text;
begin
  if new.kind not in ('contribution', 'rattrapage', 'advance') then
    return null;
  end if;

  -- Decrypt the saver's phone via the existing vault_decrypt helper.
  -- SECURITY DEFINER context means the function owner (postgres) has full
  -- access; RLS on members_decrypted is bypassed by direct table read.
  select coalesce(public.vault_decrypt(phone_number_encrypted), '')
    into v_phone
    from public.members
   where id = new.member_id;

  -- Skip when the saver has no phone on file (cash-only path).
  if v_phone is null or trim(v_phone) = '' then
    return null;
  end if;

  insert into public.sms_queue (
    collector_id, transaction_id, recipient_phone, body, status
  ) values (
    new.collector_id,
    new.id,
    v_phone,
    -- STUB body — Story 6.1 will replace this trigger function with the
    -- real template (amount, projected balance, receipt URL).
    '[STUB] Transaction enregistrée',
    'queued'
  );

  return null;
end;
$$;

comment on function public.enqueue_sms_on_transaction() is
  'AFTER INSERT trigger on transactions. Story 4.3 — enqueues an sms_queue row for kinds contribution/rattrapage/advance when the member has a phone. Body is a STUB; Story 6.1 (sms-dispatch) replaces this function with the real template logic.';

revoke execute on function public.enqueue_sms_on_transaction() from public;

create trigger enqueue_sms_on_transaction_trigger
  after insert on public.transactions
  for each row execute function public.enqueue_sms_on_transaction();
