-- Story 7.4 — Migration 0058: add cycles.settled_at timestamp column.
--
-- The commit_cycle_settlement RPC (migration 0061) populates this column when
-- it transitions a cycle from 'completed' to 'settled'. NULL by default so
-- historical (pre-Story-7.4) settled cycles — there are none yet but the
-- nullability keeps the migration idempotent — don't violate the constraint.
--
-- Not exposed via a decrypted view because public.cycles is not encrypted
-- (no _decrypted projection exists; the Story 7.x lessons about updating
-- views post-column don't apply here).
--
-- See: _bmad-output/implementation-artifacts/7-4-settlement-reauth-gate.md AC #2.

alter table public.cycles
  add column if not exists settled_at timestamptz null;

comment on column public.cycles.settled_at is
  'Timestamp the cycle transitioned to status=''settled'' via commit_cycle_settlement (Story 7.4). NULL for non-settled cycles.';
