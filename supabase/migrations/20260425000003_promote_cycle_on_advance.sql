-- Story 3.3 — Migration 0021: promote_cycle_on_advance trigger.
--
-- Forward transition (FR18 partial): an advance INSERT into transactions
-- promotes the corresponding cycle from 'active' to 'with_advance'
-- atomically (same Postgres transaction as the INSERT). The cycle UPDATE
-- fires the audit_cycles trigger from migration 0007, which classifies
-- the status flip as 'cycle.transitioned' per the updated audit_emit() in
-- migration 0020.
--
-- Idempotency: the WHERE status = 'active' filter is the gate. Subsequent
-- advance INSERTs against an already-with_advance cycle UPDATE 0 rows;
-- the audit trigger does not fire. No duplicate cycle.transitioned events.
--
-- Bypass-resistance: the trigger fires regardless of caller. Story 4.x's
-- transaction-capture RPC, a future bulk-import-with-advances flow, or
-- direct service-role inserts all produce the same cycle status.
--
-- Concurrency: the UPDATE on cycles takes a row-level write lock. Two
-- concurrent advance INSERTs serialise on the cycle row; the second
-- writer sees status='with_advance' and the WHERE filter excludes it.
-- No advisory lock needed.
--
-- Reverse transition (with_advance → active when Σ(advances) reconciles
-- to 0) is DEFERRED per BDD line 757 ("not MVP-required"). It would be a
-- separate trigger AFTER UPDATE/DELETE on transactions. Do NOT add it to
-- this trigger; keep the forward path single-purpose.
--
-- See: _bmad-output/implementation-artifacts/3-3-cycle-status-transitions.md
-- AC #1 #4 #5 #6 #9.

set check_function_bodies = off;

create or replace function public.promote_cycle_on_advance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only advance transactions promote the cycle status. Contributions and
  -- rattrapages are no-ops (Story 3.4 will reject contributions on
  -- completed cycles via 409 Conflict, not via silent state mutation).
  if new.kind = 'advance' then
    update public.cycles
       set status = 'with_advance',
           updated_at = now()
     where id = new.cycle_id
       and status = 'active';
  end if;
  -- AFTER trigger may return null without affecting the originating write.
  return null;
end;
$$;

comment on function public.promote_cycle_on_advance() is
  'AFTER INSERT trigger on transactions. Story 3.3 — promotes cycles.status from active to with_advance when an advance lands. Idempotent (WHERE status=active filter). Bypass-resistant. Reverse transition deferred per BDD line 757.';

-- Lock down direct invocation (mirrors audit_emit's revoke pattern).
revoke execute on function public.promote_cycle_on_advance() from public;

create trigger promote_cycle_on_advance_trigger
  after insert on public.transactions
  for each row execute function public.promote_cycle_on_advance();
