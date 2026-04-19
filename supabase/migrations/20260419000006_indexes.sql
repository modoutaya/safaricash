-- Story 1.2 — Migration 0006: performance indexes (NFR-P2 hot-path queries).
--
-- ARCHITECTURAL DIVERGENCE FROM SPEC:
-- ----------------------------------------------------------------------------
-- The story's Task 7 calls for:
--   CREATE INDEX idx_members_collector_id_name_trgm ON members
--     USING gin (collector_id, name gin_trgm_ops);
-- to satisfy NFR-P2 (300 ms member search at 150 members). After 0005 wraps
-- members.name in Vault, that column is now a uuid (secret_id), not text, so
-- a trigram index is impossible on the encrypted form.
--
-- Decision: skip the trigram index in this migration. Story 2.1 (member-list-search)
-- owns the search-UX implementation and will decide between:
--   (a) decrypt-then-filter in app (acceptable at MVP scale: 150 members × ~1 KB
--       decrypt cost ≈ <100 ms),
--   (b) a sidecar HMAC-hashed search column for exact-match lookup,
--   (c) a normalised non-encrypted search column with explicit user consent.
-- The pg_trgm extension is still installed here so option (b) or (c) can wire
-- a trigram index in Story 2.1 without a follow-up migration churn.
--
-- See: ADR-001 § Search-on-encrypted-columns trade-off, Story 1.2 Dev Agent Record.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- pg_trgm: trigram operators for future search columns (Story 2.1).
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- transactions hot-path indexes
-- ---------------------------------------------------------------------------

-- Member profile transaction history (Story 2.4, FR13).
create index idx_transactions_member_id_created_at
  on public.transactions (member_id, created_at desc);

-- Dashboard recent activity feed (Story 9.1).
create index idx_transactions_collector_id_created_at
  on public.transactions (collector_id, created_at desc);

-- Per-cycle transaction lookup (Epic 3 cycle engine reads + Story 7.x settlement).
create index idx_transactions_cycle_id_created_at
  on public.transactions (cycle_id, created_at desc);

-- ---------------------------------------------------------------------------
-- cycles hot-path indexes
-- ---------------------------------------------------------------------------

-- Member profile cycle history (latest cycle first → cycle_number DESC).
create index idx_cycles_member_id_cycle_number
  on public.cycles (member_id, cycle_number desc);

-- Cycles-ending dashboard alerts (Story 3.5 + Story 9.2 query the next 3 days).
create index idx_cycles_collector_id_end_date
  on public.cycles (collector_id, end_date)
  where status in ('active', 'with_advance');

-- ---------------------------------------------------------------------------
-- members hot-path index (non-encrypted columns only)
-- ---------------------------------------------------------------------------

-- Default member list query: WHERE collector_id = ? ORDER BY created_at DESC.
create index idx_members_collector_id_created_at
  on public.members (collector_id, created_at desc);

-- ---------------------------------------------------------------------------
-- audit_log indexes were created in 0003 (collector_id+timestamp, entity).
-- ---------------------------------------------------------------------------
