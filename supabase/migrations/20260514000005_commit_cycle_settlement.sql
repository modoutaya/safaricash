-- Story 7.4 — Migration 0061: commit_cycle_settlement SECURITY DEFINER RPC.
--
-- The atomic settlement commit. Called by the cycle-settlement Edge Function
-- (Story 7.4) AFTER password re-auth has succeeded. Performs in ONE Postgres
-- transaction:
--   1. Lock the cycle row FOR UPDATE.
--   2. Assert ownership + preconditions (cycle exists, owned by auth.uid(),
--      status='completed', member matches).
--   3. Recompute the payout server-side: daily_amount × 29 − sum(advances
--      where undone_at IS NULL). Mirrors Story 3.2's settle() function
--      byte-for-byte (CONTRIBUTION_DAYS = 29, advances filtered for undone).
--   4. NFR-R3 zero-tolerance cross-check: raise if client expected_payout
--      ≠ server-recomputed payout. Caller must reload (the client's view
--      is stale — likely a transaction was undone or recorded between the
--      card render and the commit).
--   5. INSERT a synthetic transactions row with kind='settlement' — fires
--      the enqueue_sms_on_transaction trigger (migration 0060) which
--      queues the settlement SMS via format_sms_body('settlement', ...).
--   6. UPDATE cycles.status='settled', settled_at=now() — fires the
--      existing audit_emit_cycle_transitioned trigger which writes a
--      'cycle.settled' row to audit_log (migration 0007 line 159).
--
-- NO new audit event type. NO new SMS template. NO new allowlist. The
-- existing infrastructure (audit trigger, SMS trigger, SMS template) all
-- handle the settlement transparently once kind='settlement' and the
-- cycle status flip are in place.
--
-- Concurrency: two collectors tapping Confirm simultaneously serialize on
-- the FOR UPDATE lock. The winner commits and flips status='settled'; the
-- loser, on lock release, finds v_cycle.status='settled' and raises
-- cycle_not_settleable. No double-settlement.
--
-- See: _bmad-output/implementation-artifacts/7-4-settlement-reauth-gate.md AC #4.

set check_function_bodies = off;

create or replace function public.commit_cycle_settlement(
  p_member_id        uuid,
  p_cycle_id         uuid,
  p_expected_payout  bigint
) returns table (
  settlement_transaction_id  uuid,
  settled_payout             bigint,
  settled_at                 timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id    uuid;
  v_cycle           public.cycles%rowtype;
  v_member          public.members%rowtype;
  v_advances_sum    bigint;
  v_computed_payout bigint;
  v_amount_secret   uuid;
  v_tx_id           uuid;
  v_settled_at      timestamptz;
begin
  -- 1. JWT auth check (caller must be a signed-in collector).
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'cycle_settlement: auth required' using errcode = '28000';
  end if;

  -- 2. Lock the cycle row FOR UPDATE. Concurrent settlements serialize here.
  select * into v_cycle
    from public.cycles
   where id = p_cycle_id
   for update;

  if not found then
    raise exception 'cycle_settlement: cycle not found or not owned'
      using errcode = 'P0002';
  end if;

  -- 3. Ownership: the cycle must belong to the calling collector.
  if v_cycle.collector_id <> v_collector_id then
    raise exception 'cycle_settlement: cycle not found or not owned'
      using errcode = 'P0002';
  end if;

  -- 4. Member/cycle cross-check — defence-in-depth. The client passes both
  --    member_id and cycle_id; ensure they reference the same row.
  if v_cycle.member_id <> p_member_id then
    raise exception 'cycle_settlement: cycle/member mismatch'
      using errcode = 'P0002';
  end if;

  -- 5. Precondition: only cycles in status='completed' can be settled.
  --    Active / with_advance / settled all reject (the latter prevents
  --    double-settlement; the former two are not yet day-30).
  if v_cycle.status <> 'completed' then
    raise exception 'cycle_settlement: cycle not in completed status (got %s)', v_cycle.status
      using errcode = 'P0002',
            detail = format('cycle_id=%s status=%s', p_cycle_id, v_cycle.status);
  end if;

  -- 6. Look up member to get daily_amount (encrypted columns not needed).
  select * into v_member
    from public.members
   where id = p_member_id;

  if not found then
    raise exception 'cycle_settlement: cycle/member mismatch'
      using errcode = 'P0002';
  end if;

  -- 7. Recompute payout server-side.
  --    Formula: daily_amount × CONTRIBUTION_DAYS − Σ(advances where undone_at IS NULL).
  --    CONTRIBUTION_DAYS = 29 per Story 3.2 (cycleEngine.ts:15-16).
  --    Mirrors settle(daily_amount, advances[]) byte-for-byte.
  select coalesce(sum(public.vault_decrypt(t.amount_encrypted)::numeric(12, 0)), 0)::bigint
    into v_advances_sum
    from public.transactions t
   where t.cycle_id = p_cycle_id
     and t.kind = 'advance'
     and t.undone_at is null;

  v_computed_payout := (v_member.daily_amount::bigint * 29) - v_advances_sum;

  -- 8. NFR-R3 zero-tolerance cross-check.
  if v_computed_payout <> p_expected_payout then
    raise exception 'cycle_settlement: payout mismatch (client=%s, server=%s)',
                    p_expected_payout, v_computed_payout
      using errcode = 'P0002',
            detail = format('client_payout=%s server_payout=%s',
                            p_expected_payout, v_computed_payout);
  end if;

  -- 9. Insert the synthetic settlement transaction. Fires:
  --    a. reject_transaction_on_closed_cycle (migration 0059) — allows
  --       kind='settlement' on completed cycles.
  --    b. audit_transactions (migration 0007) — emits 'transaction.committed'.
  --    c. enqueue_sms_on_transaction (migration 0060) — forces template_key
  --       ='settlement' and queues the SMS via format_sms_body.
  --    d. promote_cycle_on_advance (migration 0021) — no-op for kind<>'advance'.
  v_amount_secret := public.vault_encrypt(v_computed_payout::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind,
    amount_encrypted, cycle_day, source
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'settlement',
    v_amount_secret, 30, 'online'
  )
  returning id into v_tx_id;

  -- 10. Update cycle status to 'settled'. Fires audit_emit (migration 0007
  --     line 159) which emits 'cycle.settled' to audit_log (status-aware
  --     UPDATE branch).
  v_settled_at := now();
  update public.cycles
     set status = 'settled',
         settled_at = v_settled_at,
         updated_at = v_settled_at
   where id = p_cycle_id;

  -- 11. Return the settlement summary to the Edge Function.
  return query select v_tx_id, v_computed_payout, v_settled_at;
end;
$$;

grant execute on function public.commit_cycle_settlement(uuid, uuid, bigint) to authenticated;

comment on function public.commit_cycle_settlement(uuid, uuid, bigint) is
  'Atomic settlement commit (Story 7.4 / FR21 / NFR-R3). Locks cycle FOR UPDATE, asserts status=''completed'' + ownership, recomputes payout server-side (daily × 29 − Σ advances) and cross-checks vs. p_expected_payout, inserts synthetic kind=''settlement'' transaction (fires SMS queue), UPDATEs cycle.status=''settled'' (fires audit cycle.settled). Caller MUST have passed re-auth (Story 1.5b verifyPassword) before invoking.';
