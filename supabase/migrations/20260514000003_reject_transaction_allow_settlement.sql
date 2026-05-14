-- Story 7.4 — Migration 0059: extend reject_transaction_on_closed_cycle to
-- allow kind = 'settlement' on completed cycles.
--
-- Baseline: migration 0022 (20260425000004_reject_transaction_on_closed_cycle.sql)
-- rejects ALL transaction kinds on completed/settled cycles. Story 7.4 needs
-- to INSERT a synthetic kind='settlement' row into a completed cycle as part
-- of the commit_cycle_settlement RPC — that's the whole point of the
-- settlement ceremony. This trigger replacement adds an explicit allow-path
-- for kind='settlement' on completed cycles. Inserts on already-settled
-- cycles remain rejected (no double-settlement).
--
-- Diff vs. baseline (migration 0022) is intentionally minimal: one extra
-- condition on the IF + a comment line. Trigger ordering, attachment, and
-- SECURITY DEFINER discipline — UNCHANGED.
--
-- See: _bmad-output/implementation-artifacts/7-4-settlement-reauth-gate.md AC #3.

set check_function_bodies = off;

create or replace function public.reject_transaction_on_closed_cycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.cycles_status_enum;
begin
  -- Single SELECT — the cycle row is locked by the FK NOT NULL constraint
  -- on transactions.cycle_id; no advisory lock needed.
  select status
    into v_status
    from public.cycles
   where id = new.cycle_id;

  -- Story 7.4 — explicit allow-path: the commit_cycle_settlement RPC
  -- inserts a synthetic kind='settlement' row into a completed cycle just
  -- before flipping it to 'settled'. Without this branch the trigger
  -- would reject the insert and the whole settlement RPC would fail.
  -- Inserts on already-settled cycles remain rejected — that's the
  -- second-half of the condition below.
  if new.kind = 'settlement' and v_status = 'completed' then
    return new;
  end if;

  if v_status in ('completed', 'settled') then
    raise exception 'cycle_closed: cannot record % on a % cycle', new.kind, v_status
      using errcode = '23514',
            detail = format('cycle_id=%s status=%s', new.cycle_id, v_status),
            hint   = 'Restart the cycle via restart_member_cycle RPC';
  end if;

  return new;
end;
$$;

comment on function public.reject_transaction_on_closed_cycle() is
  'BEFORE INSERT trigger on transactions. Story 3.4 / FR19 — rejects transaction kinds (contribution, rattrapage, advance) on completed/settled cycles via sqlstate 23514. Story 7.4 — allows kind=''settlement'' on cycles in status=''completed'' (the commit_cycle_settlement RPC insert path).';

revoke execute on function public.reject_transaction_on_closed_cycle() from public;

-- The trigger attachment (reject_transaction_on_closed_cycle_trigger) from
-- migration 0022 is unchanged. CREATE OR REPLACE FUNCTION re-binds the body
-- without touching the trigger registration.
