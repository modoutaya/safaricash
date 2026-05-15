-- Story 8.4 code-review patch — re-partition the event_id UNIQUE index
-- by (collector_id, event_id).
--
-- The previous index from migration 0056 (transactions_event_id_idx ON
-- (event_id) WHERE event_id IS NOT NULL) was system-wide: any
-- event_id reuse across collectors would hit a 23505 unique_violation.
-- The original column comment promised "partitioned by collector_id"
-- but the index didn't match.
--
-- This migration replaces the index with a partition-aware variant:
-- (collector_id, event_id) WHERE event_id IS NOT NULL. Semantically:
--   - Same-collector replay: idempotent (the RPC's early-return matches
--     on the same partition).
--   - Cross-collector event_id collision (cryptographically improbable
--     but possible): both collectors get fresh INSERTs, partitions
--     stay isolated. Matches AC #20 "fresh INSERT via the RLS-aware
--     WHERE clause" semantic.
--
-- The early-return in the 3 record-* RPCs (migrations 0057-0059)
-- already filters by `event_id = p_event_id AND collector_id = auth.uid()`
-- so the RPC code does NOT need to change — it already aligns with the
-- new partition.
--
-- See Story 8.4 code-review HIGH patch #1.

drop index if exists public.transactions_event_id_idx;

create unique index transactions_event_id_idx
  on public.transactions (collector_id, event_id)
  where event_id is not null;

comment on index public.transactions_event_id_idx is
  'Story 8.4 (code-review patch) — partial UNIQUE on (collector_id, event_id). Replaces the system-wide variant from migration 0056. Enforces idempotent-replay safety per collector: each collector has their own event_id namespace, and same-collector replay hits the RPC''s early-return. Cross-collector event_id reuse is cryptographically improbable but harmlessly results in two distinct rows.';

-- Column comment correction — the original from 0056 was technically
-- accurate ("partitioned by collector_id") only after this re-partition.
comment on column public.transactions.event_id is
  'Story 8.4 — client-generated UUID for idempotent reconciler replay. NULL for pre-8.4 rows. UNIQUE within a collector''s partition (partial index transactions_event_id_idx). Cross-collector event_id reuse produces distinct rows.';
