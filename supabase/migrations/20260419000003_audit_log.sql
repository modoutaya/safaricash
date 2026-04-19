-- Story 1.2 — Migration 0003: audit_log constraints, indexes, write revokes.
--
-- The audit_log TABLE is created in 0001. This migration adds the
-- defence-in-depth pieces:
--   - CHECK constraint on event_type matching the architecture's naming
--     convention ({entity}.{action}, lowercase, underscore-allowed).
--   - Indexes for the per-collector chain walk and entity-level history.
--   - REVOKE INSERT/UPDATE/DELETE from public, authenticated, anon so that
--     even if an RLS policy were accidentally added, no app role could write.
--
-- The actual hash-chain trigger function lives in 0007.
--
-- See: architecture.md § Communication Patterns → Event naming.

-- ---------------------------------------------------------------------------
-- event_type format: {entity}.{action}, e.g. member.created, transaction.committed
-- ---------------------------------------------------------------------------

alter table public.audit_log
  add constraint audit_log_event_type_format_chk
  check (event_type ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$');

-- ---------------------------------------------------------------------------
-- Hash length defense-in-depth.
-- SHA-256 always produces exactly 32 bytes; null prev_hash is genesis only.
-- Without these checks, a hand-inserted row with entry_hash = '\x' (empty)
-- would collapse with the genesis prev_hash convention (also empty bytes
-- via coalesce in the trigger).
-- ---------------------------------------------------------------------------

alter table public.audit_log
  add constraint audit_log_entry_hash_length_chk
  check (octet_length(entry_hash) = 32);

alter table public.audit_log
  add constraint audit_log_prev_hash_length_chk
  check (prev_hash is null or octet_length(prev_hash) = 32);

-- ---------------------------------------------------------------------------
-- actor must be either the literal 'system' (trigger / service-role / cron)
-- or a UUID v4 string (auth.uid() result). Locks down semantic widening.
-- ---------------------------------------------------------------------------

alter table public.audit_log
  add constraint audit_log_actor_format_chk
  check (
    actor = 'system'
    or actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Per-collector chain walk + per-collector audit history (Story 9.x ops queries).
create index idx_audit_log_collector_id_timestamp
  on public.audit_log (collector_id, timestamp desc);

-- Entity-level audit lookup (Story 2.4 member profile timeline).
create index idx_audit_log_entity_table_entity_id
  on public.audit_log (entity_table, entity_id);

-- ---------------------------------------------------------------------------
-- Lock down direct mutations.
-- Only the SECURITY DEFINER trigger function in 0007 may insert (it executes
-- as the function owner, so it bypasses these GRANTs/policies by design).
-- ---------------------------------------------------------------------------

revoke insert, update, delete on public.audit_log from public;
revoke insert, update, delete on public.audit_log from anon;
revoke insert, update, delete on public.audit_log from authenticated;
