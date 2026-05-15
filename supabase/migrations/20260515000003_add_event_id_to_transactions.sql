-- Story 8.4 — Migration 0056: add event_id column to transactions.
--
-- Enables server-side idempotent replay for the offline reconciler
-- (Story 8.4's `reconciler.ts`). The reconciler pushes events from the
-- IndexedDB outbox to Supabase via the record_* RPCs; each RPC accepts
-- an optional p_event_id UUID (next migrations 0057/0058/0059) and
-- early-returns the existing transaction id if a row with that event_id
-- already exists for the same collector. This makes retries safe under
-- any failure mode (network glitch after insert, page reload mid-RPC,
-- cross-tab double drain).
--
-- The column is NULLABLE — pre-8.4 rows (Stories 4.3-5.4) keep their
-- NULL event_id and are simply skipped by the idempotency check. The
-- partial UNIQUE index (`WHERE event_id IS NOT NULL`) enforces
-- uniqueness only on the populated subset, leaving the pre-8.4 rows
-- collision-free.
--
-- transactions_decrypted view is re-created to expose event_id per the
-- project discipline (memory project_views_after_columns.md): the
-- decrypted view is an EXPLICIT projection; new columns on the
-- underlying table are NOT auto-exposed.
--
-- See: _bmad-output/implementation-artifacts/8-4-reconciler-replay.md AC #1.

-- Column.
alter table public.transactions
  add column event_id uuid null;

comment on column public.transactions.event_id is
  'Story 8.4 — client-generated UUID for idempotent reconciler replay. NULL for pre-8.4 rows. Partitioned by collector_id via the partial UNIQUE index transactions_event_id_idx.';

-- Partial unique index — only populated rows participate in the
-- uniqueness constraint. NULLs are allowed in unlimited quantity
-- (Postgres semantics for partial indexes).
create unique index transactions_event_id_idx
  on public.transactions (event_id)
  where event_id is not null;

comment on index public.transactions_event_id_idx is
  'Story 8.4 — partial UNIQUE on event_id. Enforces idempotent-replay safety: the reconciler can retry the same event without creating duplicate transactions. Pre-8.4 rows (event_id NULL) are excluded from the constraint.';

-- Re-derive transactions_decrypted to expose event_id. Mirrors migration
-- 0054 (Story 6.7) byte-for-byte EXCEPT adds `t.event_id` to the SELECT
-- list. The reconciler doesn't read from the view (it calls RPCs), but
-- exposing event_id keeps the decrypted projection consistent with the
-- underlying table and lets future stories (e.g., a server-side "is this
-- event replayed" audit query from the client) work without an extra
-- migration.
create or replace view public.transactions_decrypted
with (security_invoker = true)
as
select
  t.id,
  t.collector_id,
  t.member_id,
  t.cycle_id,
  t.kind,
  -- nullif() guards against an empty-string plaintext escaping the app
  -- boundary (positivity check moved to Zod, but defensive for the view).
  nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount,
  t.cycle_day,
  t.source,
  t.created_at,
  t.updated_at,
  t.days_covered,
  t.receipt_token,
  t.event_id
from public.transactions t
where t.undone_at is null;

comment on view public.transactions_decrypted is
  'Decrypted projection of transactions. amount is numeric(12,0). security_invoker = true → caller RLS on transactions applies. Story 4.5: filters undone rows. Story 6.7: exposes receipt_token. Story 8.4: exposes event_id for idempotent-replay audits.';

grant select on public.transactions_decrypted to authenticated;
