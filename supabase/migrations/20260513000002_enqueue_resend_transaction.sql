-- Story 6.7 — Migration 0055: enqueue_resend_transaction SECURITY DEFINER RPC.
--
-- Per-transaction counterpart to Story 6.6's enqueue_resend_history.
-- Re-enqueues ONE transaction as a 'resend' sms_queue row. No password
-- re-auth required (FR5 only covers full-cycle resends; per-tx is a
-- low-stakes single-SMS support flow).
--
-- Returns (enqueued int, reason text):
--   (1, NULL)              — happy path; one row enqueued
--   (0, 'opt_out')         — Story 6.5 handshake (saver opted out)
--   (0, 'no_phone')        — cash-only saver (empty phone_number_encrypted)
--   (0, 'undone')          — Story 4.5 handshake (defensive; UI filters out)
--   (0, 'unsupported_kind') — settlement / future kinds (defensive)
--
-- Negative branches raise P0002 'not_found' for:
--   - non-existent transaction
--   - transaction not owned by caller
--
-- Audit: ONE sms.resend_initiated event with payload {transaction_id, member_id}
-- (distinct from Story 6.6's {member_id, cycle_id, count} — the absence of
-- cycle_id+count tells auditors the scope is per-transaction).
--
-- Reuses Story 6.6's:
--   - 'resend' template_key (CHECK extended in migration 0050)
--   - format_resend_sms_body helper (migration 0052)
--   - 'sms.resend_initiated' audit allowlist (migration 0051)
--
-- See: _bmad-output/implementation-artifacts/6-7-per-transaction-receipt-share.md
--      AC #2 / #3.

set check_function_bodies = off;

create or replace function public.enqueue_resend_transaction(
  p_transaction_id uuid
)
returns table (enqueued int, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id uuid;
  v_tx_owner     uuid;
  v_tx_kind      text;
  v_tx_undone    timestamptz;
  v_member_id    uuid;
  v_opt_out      boolean;
  v_phone        text;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- 1. Load transaction + ownership + member-side gates in one join. FOR KEY
  --    SHARE locks the row against concurrent undo for the duration of the
  --    enqueue (cheap; only takes a key-share lock).
  select t.collector_id, t.kind, t.undone_at, t.member_id,
         m.sms_opt_out,
         coalesce(public.vault_decrypt(m.phone_number_encrypted), '')
    into v_tx_owner, v_tx_kind, v_tx_undone, v_member_id, v_opt_out, v_phone
    from public.transactions t
    join public.members m on m.id = t.member_id
   where t.id = p_transaction_id
   for key share of t;

  if v_tx_owner is null then
    -- Use the same message + sqlstate for both "doesn't exist" and "not
    -- owned by caller" to avoid existence-enumeration leaks via PostgREST
    -- error.message inspection (lesson learned from Story 6.6 review).
    raise exception 'transaction_not_found: % does not exist', p_transaction_id
      using errcode = 'P0002';
  end if;
  if v_tx_owner <> v_collector_id then
    raise exception 'transaction_not_found: % does not exist', p_transaction_id
      using errcode = 'P0002';
  end if;

  -- 2. Soft-undo gate (Story 4.5 handshake). UI cannot reach this branch
  --    because transactions_decrypted filters undone rows out of the list,
  --    but defend the race window between page load and resend tap.
  if v_tx_undone is not null then
    return query select 0, 'undone'::text;
    return;
  end if;

  -- 3. Kind gate (defensive). Mirrors enqueue_sms_on_transaction's filter
  --    and the existing format_sms_body contract.
  if v_tx_kind not in ('contribution', 'rattrapage', 'advance') then
    return query select 0, 'unsupported_kind'::text;
    return;
  end if;

  -- 4. Opt-out short-circuit (Story 6.5 handshake).
  if v_opt_out then
    return query select 0, 'opt_out'::text;
    return;
  end if;

  -- 5. Cash-only saver — no phone, no SMS path.
  if v_phone is null or trim(v_phone) = '' then
    return query select 0, 'no_phone'::text;
    return;
  end if;

  -- 6. Enqueue the single row. format_resend_sms_body internally enforces
  --    ownership (Story 6.6 code-review patch D1), so re-checking here would
  --    be redundant; the join above already established ownership.
  insert into public.sms_queue (
    collector_id, transaction_id, recipient_phone, body, status,
    template_key, retry_count
  )
  values (
    v_collector_id,
    p_transaction_id,
    v_phone,
    public.format_resend_sms_body(p_transaction_id),
    'queued',
    'resend',
    0
  );

  -- 7. Audit emit — ONE event. Payload carries transaction_id (per-tx scope)
  --    so an auditor can slice resend events by scope:
  --      payload->>'cycle_id' IS NOT NULL → Story 6.6 full-cycle resend
  --      payload->>'transaction_id' IS NOT NULL → Story 6.7 per-tx resend.
  perform public.audit_append_external(
    'sms.resend_initiated',
    p_transaction_id,
    'transactions',
    jsonb_build_object(
      'transaction_id', p_transaction_id,
      'member_id',      v_member_id
    )
  );

  return query select 1, null::text;
end;
$$;

comment on function public.enqueue_resend_transaction(uuid) is
  'Story 6.7 / FR36 — re-enqueues a single transaction as an SMS resend row. Returns (enqueued, reason): (1, NULL) success / (0, opt_out|no_phone|undone|unsupported_kind) short-circuit. Raises P0002 on ownership failure. Emits ONE sms.resend_initiated audit event with payload {transaction_id, member_id} when enqueued > 0. Cycle gate intentionally open (active OR settled cycles).';

grant execute on function public.enqueue_resend_transaction(uuid) to authenticated;
revoke execute on function public.enqueue_resend_transaction(uuid) from public;
