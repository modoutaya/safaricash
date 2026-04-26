-- Story 4.5 / FR22 support — Migration 0029: undo_transaction SECURITY DEFINER RPC.
--
-- Atomic soft-undo:
--   1. Validates auth.uid() non-null → 28000.
--   2. Loads the transaction; rejects:
--      - not_found → P0002
--      - foreign collector → 28000
--      - already undone (undone_at NOT NULL) → 0L000 (idempotent guard)
--      - past 5-second window (now() - created_at > 5s) → 22023
--   3. UPDATE transactions SET undone_at = now() WHERE id = p_transaction_id
--      The audit trigger (patched in migration 0030) detects the undo
--      pattern and emits a typed `transaction.undone` event instead of
--      generic `transaction.updated`.
--   4. UPDATE sms_queue SET status='abandoned' WHERE transaction_id =
--      p_transaction_id AND status='queued'. Only the not-yet-dispatched
--      rows; if the worker already moved the row to sent/delivered, the
--      SMS has left the building (saver received the receipt) — undo
--      rolls back the DB state but not reality.
--
-- 5-second window is the UX promise (the toast hides Annuler at T-0); the
-- server uses STRICT > so a tap right at T-0 with network lag still wins.
--
-- See: _bmad-output/implementation-artifacts/4-5-undo-transaction-window.md AC #3.

set check_function_bodies = off;

create or replace function public.undo_transaction(p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id uuid;
  v_owner        uuid;
  v_undone_at    timestamptz;
  v_created_at   timestamptz;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  select collector_id, undone_at, created_at
    into v_owner, v_undone_at, v_created_at
    from public.transactions
   where id = p_transaction_id;

  if v_owner is null then
    raise exception 'not_found: transaction % does not exist', p_transaction_id using errcode = 'P0002';
  end if;
  if v_owner <> v_collector_id then
    raise exception 'unauthorized: transaction % is not owned by caller', p_transaction_id
      using errcode = '28000';
  end if;
  if v_undone_at is not null then
    raise exception 'already_undone: transaction % already undone at %', p_transaction_id, v_undone_at
      using errcode = '0L000';
  end if;
  if now() - v_created_at > interval '5 seconds' then
    raise exception 'window_expired: undo window of 5 seconds elapsed (transaction created at %)', v_created_at
      using errcode = '22023';
  end if;

  -- Soft-undo. The audit trigger (migration 0030) fires AFTER UPDATE and
  -- emits transaction.undone for this exact pattern (OLD.undone_at NULL
  -- → NEW.undone_at NOT NULL).
  update public.transactions
     set undone_at = now()
   where id = p_transaction_id;

  -- Cancel any pending SMS for this transaction (status='queued' only).
  update public.sms_queue
     set status = 'abandoned'
   where transaction_id = p_transaction_id
     and status = 'queued';
end;
$$;

grant execute on function public.undo_transaction(uuid) to authenticated;

comment on function public.undo_transaction(uuid) is
  'Story 4.5 / FR22 support — atomic soft-undo of a transaction within the 5-second window. Sets transactions.undone_at; cancels queued sms_queue rows; emits transaction.undone audit event (via the patched audit_emit). Idempotent guard (0L000) on already-undone rows; 5-s window enforced server-side (22023).';
