-- Story 6.6 — Migration 0053: enqueue_resend_history SECURITY DEFINER RPC.
--
-- Re-enqueues every live transaction (contribution / rattrapage / advance,
-- undone_at IS NULL) for a member's cycle as 'resend' sms_queue rows so
-- the Story 6.2 worker can drain them to Termii.
--
-- Returns (enqueued int, reason text):
--   (n, NULL)              — n rows enqueued (n >= 1)
--   (0, 'opt_out')         — Story 6.5 handshake: saver has opted out
--   (0, 'no_phone')        — cash-only saver (no phone_number_encrypted)
--   (0, 'no_transactions') — empty cycle (no live tx of supported kind)
--
-- Negative branches raise:
--   28000 — caller is not authenticated
--   P0002 — member not owned by caller / cycle not owned by member
--
-- Emits ONE sms.resend_initiated audit event per call (only when
-- enqueued > 0). 4-arg audit_append_external — the RPC runs under the
-- collector's JWT.
--
-- Cycle gate: ANY cycle (active or settled) is allowed. A saver may ask
-- for the history of cycle 1 even though cycle 2 is in progress.
--
-- See: _bmad-output/implementation-artifacts/6-6-resend-cycle-history.md
--      AC #4 / #7 / #8.

set check_function_bodies = off;

create or replace function public.enqueue_resend_history(
  p_member_id uuid,
  p_cycle_id  uuid
)
returns table (enqueued int, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id uuid;
  v_member_owner uuid;
  v_opt_out      boolean;
  v_phone        text;
  v_cycle_member uuid;
  v_count        int;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- 1. Ownership check: member exists AND is owned by the caller.
  select collector_id, sms_opt_out,
         coalesce(public.vault_decrypt(phone_number_encrypted), '')
    into v_member_owner, v_opt_out, v_phone
    from public.members
   where id = p_member_id;

  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_member_id
      using errcode = 'P0002';
  end if;
  if v_member_owner <> v_collector_id then
    raise exception 'not_found: member % is not owned by caller', p_member_id
      using errcode = 'P0002';
  end if;

  -- 2. Cycle ownership: cycle belongs to the member.
  select member_id
    into v_cycle_member
    from public.cycles
   where id = p_cycle_id;

  if v_cycle_member is null or v_cycle_member <> p_member_id then
    raise exception 'not_found: cycle % does not belong to member %', p_cycle_id, p_member_id
      using errcode = 'P0002';
  end if;

  -- 3. Opt-out short-circuit (Story 6.5 handshake).
  if v_opt_out then
    return query select 0, 'opt_out'::text;
    return;
  end if;

  -- 4. Cash-only saver: no phone on file → cannot dispatch SMS.
  if v_phone is null or trim(v_phone) = '' then
    return query select 0, 'no_phone'::text;
    return;
  end if;

  -- 5. Enqueue one sms_queue row per live transaction in the cycle.
  --    Filters: undone_at IS NULL (Story 4.5 handshake) and supported
  --    transactional kinds (mirrors enqueue_sms_on_transaction's filter).
  --
  --    Code-review patch (D2): Postgres does NOT preserve a CTE's
  --    ORDER BY through `INSERT … SELECT`, and `clock_timestamp()` is
  --    constant within the SELECT, so rows would otherwise share a
  --    `created_at` and the worker's `ORDER BY created_at` drain would
  --    dispatch in physical-row order (undefined). Stagger `created_at`
  --    by microsecond offsets keyed on the transaction's own
  --    chronological order so the saver receives the rappels in the
  --    same order as the original receipts.
  with eligible as (
    select t.id,
           t.collector_id,
           row_number() over (order by t.created_at asc, t.id asc) as rn
      from public.transactions t
     where t.cycle_id = p_cycle_id
       and t.member_id = p_member_id
       and t.undone_at is null
       and t.kind in ('contribution', 'rattrapage', 'advance')
  ),
  inserted as (
    insert into public.sms_queue (
      collector_id, transaction_id, recipient_phone, body, status,
      template_key, retry_count, created_at
    )
    select
      e.collector_id,
      e.id,
      v_phone,
      public.format_resend_sms_body(e.id),
      'queued',
      'resend',
      0,
      clock_timestamp() + (e.rn * interval '1 microsecond')
    from eligible e
    returning 1
  )
  select count(*)::int into v_count from inserted;

  if v_count = 0 then
    return query select 0, 'no_transactions'::text;
    return;
  end if;

  -- 6. Audit emit — ONE event per call.
  perform public.audit_append_external(
    'sms.resend_initiated',
    p_member_id,
    'members',
    jsonb_build_object(
      'member_id', p_member_id,
      'cycle_id',  p_cycle_id,
      'count',     v_count
    )
  );

  return query select v_count, null::text;
end;
$$;

comment on function public.enqueue_resend_history(uuid, uuid) is
  'Story 6.6 / FR33 — re-enqueues a member''s cycle history as SMS resend rows. Returns (enqueued, reason): (n, NULL) success / (0, opt_out|no_phone|no_transactions) short-circuit. Raises P0002 on ownership failure. Emits ONE sms.resend_initiated audit event when enqueued > 0. Cycle gate is intentionally open (active OR settled cycles).';

grant execute on function public.enqueue_resend_history(uuid, uuid) to authenticated;
revoke execute on function public.enqueue_resend_history(uuid, uuid) from public;
