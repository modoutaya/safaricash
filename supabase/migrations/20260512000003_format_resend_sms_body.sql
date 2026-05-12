-- Story 6.6 — Migration 0052: format_resend_sms_body SQL helper.
--
-- Wraps Story 6.3's format_sms_body('subsequent_receipt', tx_id) by
-- prefixing the body with "Rappel - transaction du JJ/MM: " — used by
-- the Story 6.6 cycle-history resend and (1:1, no parameter change) by
-- Story 6.7's per-transaction resend.
--
-- Length budget:
--   - prefix: "Rappel - transaction du JJ/MM: " = 31 chars
--   - subsequent_receipt worst case: ~132 chars
--   - total worst case: ~163 chars → 2-segment SMS. Acceptable for
--     low-volume support flow (lower than fresh-receipt traffic).
--
-- NFR-A6 compliance:
--   - The prefix uses ASCII hyphen `-`, NOT em-dash `—` (em-dash is NOT
--     in the GSM-7 default alphabet — would force UCS-2 encoding and
--     halve the segment size).
--   - format_sms_body already runs the saver name through unaccent();
--     this helper does not introduce non-ASCII characters of its own.
--
-- Date format:
--   - JJ/MM (DD/MM) in Africa/Dakar timezone.
--   - Africa/Dakar is UTC+0 year-round (no DST), so the local date is
--     equivalent to the UTC date for transactions captured between 00:00
--     and 23:59 local time. Using `at time zone 'Africa/Dakar'` is
--     explicit and future-proof.
--
-- See: _bmad-output/implementation-artifacts/6-6-resend-cycle-history.md AC #3.

set check_function_bodies = off;

create or replace function public.format_resend_sms_body(
  p_transaction_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx_date  text;
  v_base     text;
  v_created  timestamptz;
  v_caller   uuid;
  v_owner    uuid;
begin
  -- Code-review patch (D1): SECURITY DEFINER + GRANT TO authenticated
  -- means any logged-in collector could call this on any transaction id
  -- and read the saver's PII via the rendered body. Enforce ownership
  -- explicitly. Callers from enqueue_resend_history (Story 6.6) already
  -- pass this check trivially since the RPC runs under the same JWT.
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- Fetch the transaction's created_at + collector_id for the date prefix
  -- and the ownership check in one round-trip.
  select t.created_at, t.collector_id
    into v_created, v_owner
    from public.transactions t
   where t.id = p_transaction_id;

  if v_created is null then
    -- Mirror format_sms_body's not-found behaviour.
    raise exception 'transaction_not_found: % does not exist', p_transaction_id
      using errcode = 'P0002';
  end if;
  if v_owner <> v_caller then
    -- Same SQLSTATE as not-found — defeats existence-leak via PostgREST
    -- error.message inspection.
    raise exception 'transaction_not_found: % does not exist', p_transaction_id
      using errcode = 'P0002';
  end if;

  -- Format date as JJ/MM (day/month, ASCII) in Africa/Dakar tz.
  v_tx_date := to_char(v_created at time zone 'Africa/Dakar', 'DD/MM');

  -- Delegate to the canonical body builder. Any exception (e.g., member
  -- decryption fails, unknown template) propagates up.
  v_base := public.format_sms_body('subsequent_receipt', p_transaction_id);

  -- ASCII hyphen-space-hyphen, NFR-A6 clean.
  return 'Rappel - transaction du ' || v_tx_date || ': ' || v_base;
end;
$$;

comment on function public.format_resend_sms_body(uuid) is
  'Story 6.6 / FR33 / NFR-A6 — wraps format_sms_body(subsequent_receipt, tx_id) with a "Rappel - transaction du JJ/MM: " prefix (ASCII hyphen, Africa/Dakar date). Used by Story 6.6 (cycle resend) and Story 6.7 (per-transaction resend, 1:1 reuse). Worst-case body is 2-segment SMS — accepted for low-volume support flow.';

grant execute on function public.format_resend_sms_body(uuid) to authenticated;
grant execute on function public.format_resend_sms_body(uuid) to service_role;
revoke execute on function public.format_resend_sms_body(uuid) from public;
