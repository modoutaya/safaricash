-- Story 4.4 / FR23 — Migration 0026: add transactions.days_covered + cross-kind CHECK.
--
-- Two ALTERs:
--   1. New column `days_covered integer NOT NULL DEFAULT 1` with a per-row
--      [1, 30] range CHECK. The DEFAULT 1 backfills existing rows
--      semantically — every contribution / rattrapage / advance shipped via
--      Stories 4.3 / 4.4 covers exactly 1 day each.
--   2. Cross-kind CHECK encoding the kind ⇒ days_covered shape contract:
--      - kind = 'rattrapage' ⇒ days_covered ≥ 2
--      - kind <> 'rattrapage' ⇒ days_covered = 1 (contributions and
--        advances are point-events).
--      The DB enforces the invariant regardless of the RPC layer; an
--      auditor querying the table can rely on it.
--
-- See: epics.md:847-864 (Story 4.4 BDD), prd.md:506 (FR23),
-- _bmad-output/implementation-artifacts/4-4-record-rattrapage.md AC #6 #7.

set check_function_bodies = off;

alter table public.transactions
  add column days_covered integer not null default 1
  check (days_covered between 1 and 30);

comment on column public.transactions.days_covered is
  'Number of cycle days covered by this transaction. Story 4.4 / FR23. = 1 for contribution/advance; ≥ 2 for rattrapage. Enforced by transactions_days_covered_kind_chk.';

alter table public.transactions
  add constraint transactions_days_covered_kind_chk
  check (
    (kind = 'rattrapage' and days_covered >= 2)
    or
    (kind <> 'rattrapage' and days_covered = 1)
  );
