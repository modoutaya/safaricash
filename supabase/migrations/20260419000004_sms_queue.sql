-- Story 1.2 — Migration 0004: sms_queue ownership notes + lifecycle docs.
--
-- The sms_queue TABLE and its (status, created_at) drain index are created
-- in 0001 (kept together because the table is a hard dependency of every
-- other transactional flow that emits an SMS receipt).
--
-- This migration is intentionally thin — it exists so the 7-file split per
-- architecture.md § Project Structure is preserved verbatim, and so future
-- changes scoped to sms_queue (status enum extensions, retry-policy columns,
-- partitioning) land in their own conventional file rather than mutating
-- the init migration.
--
-- See:
--   - architecture.md § Data Architecture → sms_queue
--   - epics.md Epic 6 (SMS dispatch + worker)
--   - Story 6.1 (sms-dispatch Edge Function) writes rows here
--   - Story 6.2 (sms-worker Termii drain) reads + updates rows here

-- ---------------------------------------------------------------------------
-- Defensive verification: drain index from 0001 must exist.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'idx_sms_queue_status_created_at'
  ) then
    raise exception 'sms_queue worker drain index missing — should have been created in 0001';
  end if;
end;
$$;
