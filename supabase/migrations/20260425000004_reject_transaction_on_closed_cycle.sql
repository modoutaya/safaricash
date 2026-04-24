-- Story 3.4 — Migration 0022: reject_transaction_on_closed_cycle trigger.
--
-- Server-side enforcement of FR19: any transaction insert against a
-- 'completed' or 'settled' cycle is rejected with sqlstate 23514
-- (check_violation), which PostgREST translates into HTTP 409 Conflict
-- with an RFC 7807 application/problem+json body.
--
-- ALL transaction kinds are blocked (contribution, rattrapage, advance).
-- PRD FR19 uses "contributions" generically; the intent is "no further
-- mutations to a closed cycle". Story 3.3's promote_cycle_on_advance
-- trigger already silently no-ops advances on non-active cycles; this
-- story makes the rejection explicit (collector must restart the cycle
-- via Story 2.7's restart_member_cycle RPC to record any new transaction).
--
-- Trigger ordering on public.transactions (after this migration lands):
--   1. BEFORE INSERT: reject_transaction_on_closed_cycle (this story).
--   2. (INSERT itself, if BEFORE didn't raise).
--   3. AFTER INSERT:  audit_transactions (Story 1.2, migration 0007).
--   4. AFTER INSERT:  promote_cycle_on_advance_trigger (Story 3.3,
--                     migration 0021).
--
-- See: _bmad-output/implementation-artifacts/3-4-prevent-post-completion-contributions.md

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
  'BEFORE INSERT trigger on transactions. Story 3.4 / FR19 — rejects ALL transaction kinds on completed/settled cycles via sqlstate 23514 (PostgREST → 409 Conflict). HINT points to restart_member_cycle (Story 2.7) as the recovery path.';

-- Lock down direct invocation (mirrors audit_emit + promote_cycle_on_advance).
revoke execute on function public.reject_transaction_on_closed_cycle() from public;

create trigger reject_transaction_on_closed_cycle_trigger
  before insert on public.transactions
  for each row execute function public.reject_transaction_on_closed_cycle();
