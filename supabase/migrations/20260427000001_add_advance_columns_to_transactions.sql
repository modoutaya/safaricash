-- Story 5.4 / FR24 + FR25 — Migration 0032: motive + saver_acknowledged.
--
-- Two ALTERs:
--   1. New column `motive text NULL` — populated only for kind='advance';
--      NULL for contribution and rattrapage rows.
--   2. New column `saver_acknowledged boolean NULL` — same nullability
--      contract.
--
-- Cross-kind CHECK constraint encodes the kind ⇒ motive/ack shape:
--   - kind = 'advance' ⇒ motive IS NOT NULL AND length(trim(motive)) ≥ 3
--                      AND saver_acknowledged = TRUE
--   - kind <> 'advance' ⇒ motive IS NULL AND saver_acknowledged IS NULL
--
-- Defence-in-depth alongside the record_advance RPC validation: an
-- auditor querying the table can rely on the invariant. A future bug
-- in the application layer that bypasses the RPC still gets rejected
-- by the DB.
--
-- No backfill needed — existing rows are all kind ∈ {contribution,
-- rattrapage} (Stories 4.3 + 4.4); they satisfy the
-- `motive IS NULL AND saver_acknowledged IS NULL` branch.
--
-- See: epics.md:935-949 (Story 5.4 BDD),
-- _bmad-output/implementation-artifacts/5-4-commit-advance-transaction.md AC #1.

set check_function_bodies = off;

alter table public.transactions
  add column motive text null;

alter table public.transactions
  add column saver_acknowledged boolean null;

comment on column public.transactions.motive is
  'Story 5.4 / FR25 — free-text motive captured at commit. NOT NULL for kind=advance; NULL for contribution/rattrapage. Trimmed by the RPC.';

comment on column public.transactions.saver_acknowledged is
  'Story 5.4 / FR25 — saver explicit acknowledgment of the advance impact. TRUE for kind=advance; NULL for contribution/rattrapage.';

alter table public.transactions
  add constraint transactions_advance_motive_ack_chk
  check (
    (kind = 'advance' and motive is not null and length(trim(motive)) >= 3 and saver_acknowledged = true)
    or
    (kind <> 'advance' and motive is null and saver_acknowledged is null)
  );
