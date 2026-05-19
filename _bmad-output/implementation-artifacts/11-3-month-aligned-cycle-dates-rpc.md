# Story 11.3: Month-aligned cycle dates in RPCs

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer**,
I want **`create_member_with_cycle` / `restart_member_cycle` / `commit_cycle_settlement` / `record_advance` / `record_contribution` migrations rewritten so the server emits and consumes calendar-month-aligned, variable-length cycles**,
so that **the database produces the cycles the TS engine (Story 11.2) already expects, the NFR-R3 client/server payout cross-check passes for partial cycles, and day-31 transactions on 31-day cycles are accepted (FR15, FR21, NFR-R3).**

> **This story unblocks Story 11.4 and closes Epic 11's data path.** It is gated by Story 11.2 (merged, PR #117). Without 11.3 the client and server formulas disagree the moment any non-30-day cycle exists, and 31-day cycles silently fail on their last day.
>
> **Scope was widened by the 11.2 code-review handoff (2026-05-19).** The Sprint Change Proposal originally listed only `commit_cycle_settlement`. The review flagged `record_advance` (same `× 29` capacity bug) AND the `cycle_day` ceiling (capped at 30 across DB / RPC / Zod — breaks day 31 of a 31-day cycle). All three are in this story. See `_bmad-output/implementation-artifacts/11-2-cycle-engine-variable-length.md` § "Handoff to Story 11.3" for the canonical rationale.

## Context

The TS engine after Story 11.2 derives cycle length per cycle from the row's `start_date` / `end_date`. The SQL RPCs still operate on a fixed 30-day model:

- `supabase/migrations/20260422000001_create_member_with_cycle.sql:136` — `end_date = v_today + interval '29 days'`.
- `supabase/migrations/20260424000001_restart_member_cycle.sql:98` — same.
- `supabase/migrations/20260514000005_commit_cycle_settlement.sql:120` — `v_computed_payout := (v_member.daily_amount::bigint * 29) - v_advances_sum`.
- `supabase/migrations/20260427000002_record_advance.sql:100` — `v_capacity := v_daily_amount * 29`.
- `supabase/migrations/20260427000002_record_advance.sql:65-66` — `p_cycle_day > 30 → invalid_cycle_day`.
- `supabase/migrations/20260425000005_record_contribution.sql:48-49` — same `> 30` check.
- `supabase/migrations/20260419000001_init_schema.sql:139` — `transactions.cycle_day` column-level `check (cycle_day between 1 and 30)`.
- `src/features/member/types.ts:68` — Zod `cycle_day: z.number().int().min(1).max(30)`.

The engine constant `MIN_CYCLE_LENGTH_DAYS = 3` is exported from `src/domain/cycle/cycleEngine.ts:28`; the SQL must mirror it (no Postgres-side constant import — re-declare in the function with a comment tying back to the TS source).

## Acceptance Criteria

> Numbered for traceability. **Given/When/Then** lines are the BDD source from `epics.md` Story 11.3; the rest are spec-derived. The authoritative invariant contract is ADR-004 § Amendment A1 (INV-9 + the partial-cycle math).

1. **Single migration file.** **Given** CLAUDE.md's "Local-DB workflow" rule, **When** the work lands, **Then** it ships as **one** new migration created via `npm run db:migrate:new calendar_month_cycle_rpcs` containing all the RPC + constraint changes below — atomic from a deployment standpoint, easy to roll forward. **Do NOT run `npm run db:reset`** during dev (manually-seeded local data must survive); apply via `npm run db:migrate` only.

2. **New SQL helper — `derive_cycle_bounds(p_today date)`.** **Then** the migration adds a `language plpgsql immutable` function returning `table(start_date date, end_date date)` that **mirrors** the TS `deriveCycleBounds` (`src/domain/cycle/cycleEngine.ts:78`):

   ```sql
   -- end_date = last day of month(p_today); if residual < MIN_CYCLE_LENGTH_DAYS,
   -- roll forward to the next month (start=1st, end=its last day). Year-aware
   -- via date arithmetic (date_trunc handles Dec → Jan transparently).
   ```

   The constant `3` is hardcoded with a comment: `-- mirrors src/domain/cycle/cycleEngine.ts MIN_CYCLE_LENGTH_DAYS`. Single point of edit in SQL — the two cycle-INSERT RPCs and any future caller go through this function.

3. **`create_member_with_cycle` uses `derive_cycle_bounds`.** **When** a new member is created, **Then** the cycle row is inserted with `(start_date, end_date)` from `derive_cycle_bounds(v_today)` — NOT `(v_today, v_today + interval '29 days')`. The function signature is unchanged (no caller break); only the body changes. `CREATE OR REPLACE FUNCTION` (signature stable).

4. **`restart_member_cycle` uses `derive_cycle_bounds`.** **Then** restart inserts the same way. `CREATE OR REPLACE FUNCTION`.

5. **`commit_cycle_settlement` — payout from the cycle's own dates.** **Then** the server-side payout recompute becomes:

   ```sql
   v_computed_payout := v_member.daily_amount::bigint
                       * ((v_cycle.end_date - v_cycle.start_date + 1) - 1)
                     - v_advances_sum;
   ```

   The `× 29` literal is removed. The NFR-R3 cross-check vs `p_expected_payout` is preserved. For a 30-day cycle (start + 29 days) this evaluates to `× 29` — legacy rows still match the client's `cycleLength = 30` computation byte-for-byte (ADR A1.7). For a 24-day cycle (Story 11.2's worked example) it evaluates to `× 23`.

6. **`record_advance` — capacity from the cycle's own dates.** **Then** the capacity ceiling becomes:

   ```sql
   v_capacity := v_daily_amount * ((v_cycle.end_date - v_cycle.start_date + 1) - 1);
   ```

   Re-reads `v_cycle` (the `select … into v_cycle` block at the top of the function already exists; reuse it). The `× 29` literal is removed. Legacy rows = `× 29`; partial cycles = correct tighter bound. INV-3 capacity bound matches the TS engine's `canAcceptAdvance(…, contributionDays)`.

7. **`cycle_day` ceiling raised to 31 — three layers in lockstep.** **Then**:
   - **DB column check** on `public.transactions.cycle_day` — drop the default-named constraint and re-add: `ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_cycle_day_check; ALTER TABLE public.transactions ADD CONSTRAINT transactions_cycle_day_check CHECK (cycle_day BETWEEN 1 AND 31) NOT VALID; ALTER TABLE public.transactions VALIDATE CONSTRAINT transactions_cycle_day_check;` — `NOT VALID` + separate `VALIDATE` avoids a synchronous lock-scan on a populated table (mirrors Story 10.5 patch P3 precedent).
   - **`record_contribution`** — the `p_cycle_day > 30 → invalid_cycle_day` check becomes `> 31`; error message updated to "[1, 31]".
   - **`record_advance`** — same.
   - **TypeScript Zod** — `transactionRowSchema.cycle_day` in `src/features/member/types.ts:68`: `.max(30)` → `.max(31)`. This is bundled with the migration so the three layers ship as one coherent unit.

8. **Comments + invariants traceability.** **Then** the changed RPCs' `comment on function …` strings are updated: drop the `(daily × 29 − Σ advances)` / `dailyAmount × 29` references, replace with `(daily × (cycleLength − 1) − Σ advances)` / `cycleLength` wording. Each formula change carries an inline SQL comment citing ADR-004 INV-2 / INV-3 / INV-9 by name.

9. **SQL/TS cross-check contract test.** **Then** a new Deno contract test under `supabase/functions/_shared/derive-cycle-bounds.contract.test.ts` (mirroring the existing `_shared/*.contract.test.ts` pattern) calls `derive_cycle_bounds` over Supabase and asserts byte-equivalence with the TS `deriveCycleBounds` for a fixed set of dates covering: a 30-day month registration on the 1st (full month), a 30-day month on the 7th (partial cycle length 24), a 31-day month on the 29th (rawLen 3 = MIN → no roll), a 31-day month on the 30th (rawLen 2 → roll forward), Dec → Jan year boundary (`2026-12-30` → `2027-01-01..31`), Feb leap (`2028-02-01` → `2028-02-29`), Feb non-leap (`2026-02-01` → `2026-02-28`). The test imports `deriveCycleBounds` from `src/domain/cycle/cycleEngine.ts` — Deno can import the TS file directly via a relative URL.

10. **`commit_cycle_settlement` partial-cycle test.** **Then** the existing settlement Edge Function tests (or a new contract test alongside) are extended to cover a partial cycle: seed a member with a 24-day cycle (start the 7th of a 30-day month), commit settlement with `p_expected_payout = dailyAmount × 23`, assert success and the inserted synthetic transaction's `amount` equals the partial-cycle payout. The legacy-30-day case must still pass.

11. **`record_advance` capacity test.** **Then** a Deno test seeds a 24-day partial cycle and asserts: advance of `dailyAmount × 23` is accepted (boundary); advance of `dailyAmount × 23 + 1` raises `over_limit` with the partial-cycle capacity in the message. The legacy 30-day capacity (`× 29`) case must still pass.

12. **`cycle_day = 31` acceptance test.** **Then** Deno tests for both `record_contribution` and `record_advance` assert that `p_cycle_day = 31` is **accepted** (no longer raises `invalid_cycle_day`), and `p_cycle_day = 32` is still rejected. The DB-level constraint is exercised transitively.

13. **Local smoke-test discipline.** **Then** before pushing, the dev runs the new migration locally (`npm run db:migrate`), then runs `npm run test:edge` (the project's Deno contract-test runner — see `scripts/run-edge-tests.sh`). Per memory `feedback_migration_rpc_smoke_test`: TS gates don't catch Postgres-side type errors in RPC bodies; SQL must be exercised. **The migration is verified locally before the push.**

14. **Story 11.4 boundary.** **Then** the story does **not** touch: the engine (Story 11.2 closed it); the consumers (handled in 11.2); the saver-facing display copy (`jour {cycleDay}/{N}` in `shareReceipt.ts:50` and the server `format_sms_body` denominator — those remain Story 11.4 alone). The `cycle_day` Zod ceiling IS in this story because it ships in lockstep with the DB constraint.

15. **Backward compatibility — legacy 30-day cycles.** **Then** every existing cycle row in dev / pilot DBs continues to settle and accept advances correctly. `end_date − start_date + 1 = 30` for legacy rows (Story 11.2 ADR A1.7), so `(cycleLength − 1) = 29` for them and every formula evaluates to the pre-11.3 numbers. **No data backfill is needed**; do NOT include any `UPDATE cycles SET end_date = …` in the migration.

16. **Idempotency / re-runnability.** **Then** the migration uses `create or replace function` and `drop constraint if exists` / `add constraint …` so re-applying it to an already-migrated DB is a no-op. Mirrors the project's existing migration-style idiom.

17. **Audit trail intact.** **Then** the migration does not alter any audit-emit trigger logic; `cycle.started` / `cycle.settled` / `transaction.committed` events continue to fire from the existing triggers (`supabase/migrations/20260419000007_triggers_audit.sql` and `20260425000002_audit_emit_cycle_transitioned.sql`). The hash-chain is not touched.

18. **Sprint-status handoff for 11.4.** **Then** the `11-4-cycle-consumer-and-sms-copy-updates` entry comment is updated (if needed) to confirm the scope is now ONLY the SMS / receipt-URL display copy (`shareReceipt.ts:50` + server `format_sms_body` denominator) — the engine-bound consumer math was absorbed by 11.2 and the SQL math is closed here.

## Tasks / Subtasks

- [ ] **Task 0 — Read the inputs.** Re-read ADR-004 § Amendment A1 (INV-9 + A1.5 `MIN_CYCLE_LENGTH_DAYS` + A1.7 legacy), Story 11.2's "Handoff to Story 11.3" section, and each of the 4 migration files listed in Context. Confirm the locked formulas before writing SQL.

- [ ] **Task 1 — New migration file (AC #1 #16).** `npm run db:migrate:new calendar_month_cycle_rpcs`. The new file holds all SQL changes below; written so re-applying it is a no-op.

- [ ] **Task 2 — `derive_cycle_bounds` SQL helper (AC #2).** `CREATE OR REPLACE FUNCTION public.derive_cycle_bounds(p_today date) RETURNS TABLE(start_date date, end_date date) LANGUAGE plpgsql IMMUTABLE`. Body: month-end via `date_trunc('month', p_today) + interval '1 month - 1 day'`; roll-forward via `date_trunc('month', p_today) + interval '1 month'` (year-safe). Hardcode `3` with a comment tying back to `MIN_CYCLE_LENGTH_DAYS`.

- [ ] **Task 3 — Rewrite the two cycle-INSERT RPCs (AC #3 #4).** `CREATE OR REPLACE` `create_member_with_cycle` and `restart_member_cycle`. Replace the `v_today + interval '29 days'` expressions with a `select start_date, end_date into … from derive_cycle_bounds(v_today)` block; INSERT uses the derived dates.

- [ ] **Task 4 — Rewrite `commit_cycle_settlement` payout recompute (AC #5 #8).** `CREATE OR REPLACE`. Replace line ~120 with `v_member.daily_amount::bigint * ((v_cycle.end_date - v_cycle.start_date + 1) - 1) - v_advances_sum`. Drop the `CONTRIBUTION_DAYS = 29` comment; cite ADR INV-2. Update the function `COMMENT`.

- [ ] **Task 5 — Rewrite `record_advance` capacity (AC #6 #8).** `CREATE OR REPLACE`. Replace `v_capacity := v_daily_amount * 29` with the cycle-derived form. Update the function `COMMENT`. Cite ADR INV-3.

- [ ] **Task 6 — Raise `cycle_day` ceiling — DB + RPCs (AC #7 #8).** `ALTER TABLE … DROP CONSTRAINT IF EXISTS transactions_cycle_day_check; ADD CONSTRAINT transactions_cycle_day_check CHECK (cycle_day BETWEEN 1 AND 31) NOT VALID; VALIDATE CONSTRAINT …`. Then `CREATE OR REPLACE` `record_contribution` + `record_advance` so the `p_cycle_day > 30` checks become `> 31`; error messages updated.

- [ ] **Task 7 — Zod schema ceiling (AC #7).** Edit `src/features/member/types.ts:68` `transactionRowSchema.cycle_day`: `.max(30)` → `.max(31)`. Update the inline comment to reference the new `cycle_day` ceiling.

- [ ] **Task 8 — Deno contract tests (AC #9 #10 #11 #12 #13).** Add `supabase/functions/_shared/derive-cycle-bounds.contract.test.ts` (SQL/TS cross-check across the 7 representative dates in AC #9). Extend (or add alongside) settlement + advance contract tests for partial-cycle math + the `cycle_day = 31` acceptance case. Run `npm run test:edge` locally — green before push.

- [ ] **Task 9 — Local smoke + gates.**
  - `npm run db:migrate` (apply locally; preserves manually-seeded data).
  - `psql` smoke-test on each touched RPC against the local DB (call `derive_cycle_bounds` directly with `2026-04-07` / `2026-04-29` / `2026-12-30`; insert a test cycle via `create_member_with_cycle`; verify `end_date`).
  - `npm run typecheck` / `npm run lint` / `npm run test -- --coverage` (Zod change is the only TS edit — should be trivially clean).
  - `npm run test:edge` (Deno).
  - `npm run build`.

- [ ] **Task 10 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `11-3-month-aligned-cycle-dates-rpc: ready-for-dev` → `review`.
  - Update `11-4` entry comment per AC #18.

## Dev Notes

### Architecture compliance

- **Single source of truth — TS engine is canonical.** ADR-004 Decision #1 says the cycle engine is the only place cycle math lives. `derive_cycle_bounds` SQL is the **SQL mirror** of `src/domain/cycle/cycleEngine.ts deriveCycleBounds`. The contract test (Task 8) is the guardrail keeping them aligned — exactly the same pattern as `settle()` ↔ `commit_cycle_settlement`'s recompute (Story 7.4).
- **No new dependencies.** Pure SQL + Deno + Zod edit. No `package.json` change.
- **CLAUDE.md compliance.** `npm run db:migrate:new` (NOT `db:reset`). Update `members_decrypted` / `transactions_decrypted` views only if a new column is added — none are here, so views are unchanged (memory `project_views_after_columns`).

### Migration body — illustrative pseudocode

```sql
-- 11-3 — calendar-month cycle dates in RPCs (ADR-004 Amendment A1, Story 11.3).

create or replace function public.derive_cycle_bounds(p_today date)
returns table(start_date date, end_date date)
language plpgsql immutable
as $$
declare
  v_month_end date := (date_trunc('month', p_today) + interval '1 month - 1 day')::date;
  v_raw_len   integer := (v_month_end - p_today) + 1;
  -- 3 mirrors src/domain/cycle/cycleEngine.ts MIN_CYCLE_LENGTH_DAYS (ADR-004 § A1.5).
  v_min       constant integer := 3;
begin
  if v_raw_len >= v_min then
    return query select p_today, v_month_end;
  else
    return query select
      (date_trunc('month', p_today) + interval '1 month')::date,
      (date_trunc('month', p_today) + interval '2 month - 1 day')::date;
  end if;
end;
$$;

grant execute on function public.derive_cycle_bounds(date) to authenticated;
-- (also to service_role implicitly via SECURITY DEFINER callers)

-- create_member_with_cycle, restart_member_cycle: select … into v_start, v_end
--   from public.derive_cycle_bounds(v_today); insert (start_date, end_date)
--   = (v_start, v_end). Else identical.

-- commit_cycle_settlement: v_computed_payout := v_member.daily_amount::bigint
--   * ((v_cycle.end_date - v_cycle.start_date + 1) - 1) - v_advances_sum.

-- record_advance: v_capacity := v_daily_amount
--   * ((v_cycle.end_date - v_cycle.start_date + 1) - 1).

-- DB constraint:
alter table public.transactions drop constraint if exists transactions_cycle_day_check;
alter table public.transactions add constraint transactions_cycle_day_check
  check (cycle_day between 1 and 31) not valid;
alter table public.transactions validate constraint transactions_cycle_day_check;

-- record_contribution + record_advance: change the cycle_day > 30 check to > 31.
```

### Contract test sketch

```ts
// supabase/functions/_shared/derive-cycle-bounds.contract.test.ts
import { deriveCycleBounds } from "../../../src/domain/cycle/cycleEngine.ts";

const cases = [
  "2026-04-01", // full April (30 days)
  "2026-04-07", // partial, length 24 — the worked example
  "2026-01-29", // 31-day month, rawLen 3 = MIN → no roll
  "2026-01-30", // 31-day month, rawLen 2 < MIN → roll to February
  "2026-12-30", // Dec → Jan year boundary
  "2028-02-01", // leap February, end = 2028-02-29
  "2026-02-01", // non-leap February, end = 2026-02-28
];
for (const today of cases) {
  const ts = deriveCycleBounds(today);
  const { data: sql } = await supabase.rpc("derive_cycle_bounds", { p_today: today });
  // assertEquals(sql[0], { start_date: ts.startDate, end_date: ts.endDate })
}
```

### `supabase.rpc` this-binding (memory)

When invoking the new function from Deno tests, do NOT extract `supabase.rpc` into a free variable (memory `project_supabase_rpc_binding` — loses `this.rest` access). Call it inline: `supabase.rpc("derive_cycle_bounds", { p_today: "…" })`.

### `members_decrypted` / `transactions_decrypted` (memory)

These views are explicit projections (memory `project_views_after_columns`). This story adds NO new columns — neither view needs updating.

### Anti-patterns (do NOT do)

- **Do NOT run `npm run db:reset`** during dev — it wipes manually-seeded local data (CLAUDE.md § Local-DB workflow + memory).
- **Do NOT backfill `cycles.end_date`** — legacy rows are correct as-is (ADR A1.7); a backfill would CORRUPT them by overwriting their stored 30-day window with month-aligned bounds, breaking NFR-R3 for completed-but-unsettled cycles whose SMS receipts already promised the 30-day numbers.
- **Do NOT inline the bounds derivation** in `create_member_with_cycle` / `restart_member_cycle`. Both go through `derive_cycle_bounds` — one definition, one source of truth, one place to fix bugs.
- **Do NOT add `cycleLength` or `contributionDays` columns** to the `cycles` table. They are derivable from `start_date`/`end_date`; persisting them invites drift. The engine derives on read.
- **Do NOT update display copy** — `shareReceipt.ts:50` `jour X/30` string and the server `format_sms_body` denominator are Story 11.4.
- **Do NOT skip the cross-check contract test** (Task 8). The whole point of SQL mirroring TS is that the test catches drift; without it the mirror is unverified.
- **Do NOT use `--no-verify`** on commits.

### Definition-of-done checklist

- All 18 ACs satisfied + all 10 tasks ticked.
- One new migration file under `supabase/migrations/`, applied locally via `npm run db:migrate` (no `db:reset`).
- `derive_cycle_bounds(date)` SQL helper exists; called by `create_member_with_cycle` + `restart_member_cycle`.
- `commit_cycle_settlement` + `record_advance` use `(end_date − start_date + 1) − 1` instead of `× 29`.
- `cycle_day` ceiling raised to 31 across the DB constraint, `record_contribution`, `record_advance`, AND `src/features/member/types.ts:68`.
- New Deno contract test cross-checks SQL `derive_cycle_bounds` against TS `deriveCycleBounds` for 7 representative dates (incl. year boundary + leap Feb).
- `commit_cycle_settlement` partial-cycle test + `record_advance` partial-capacity test + `cycle_day = 31` acceptance test all green.
- Legacy 30-day cycles still settle correctly (no backfill).
- `typecheck` / `lint` / `test --coverage` / `test:edge` / `build` all green locally.
- `members_decrypted` / `transactions_decrypted` views untouched.
- Story status → `review`; `sprint-status.yaml` updated (incl. 11.4 entry comment per AC #18).

### Project Structure Notes

- Migration: one new file under `supabase/migrations/<timestamp>_calendar_month_cycle_rpcs.sql`.
- Contract test: `supabase/functions/_shared/derive-cycle-bounds.contract.test.ts` (mirror the existing `_shared/*.contract.test.ts` files).
- TS change: `src/features/member/types.ts:68` only (one-line Zod ceiling bump).
- No new files in `src/`, no view changes, no audit-emit changes.

## References

- **ADR (canonical contract):** `docs/ADR/004-cycle-invariants.md` § Amendment A1 (INV-9 + A1.5 `MIN_CYCLE_LENGTH_DAYS` + A1.7 legacy compat).
- **Sprint Change Proposal:** `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-19.md` §4.5.
- **Predecessor story + handoff source:** `_bmad-output/implementation-artifacts/11-2-cycle-engine-variable-length.md` § "Handoff to Story 11.3" (the scope-widening rationale).
- **Epic + story:** `_bmad-output/planning-artifacts/epics.md` — Epic 11, Story 11.3.
- **Engine canonical implementation (the SQL must mirror):** `src/domain/cycle/cycleEngine.ts:78` (`deriveCycleBounds`), line 28 (`MIN_CYCLE_LENGTH_DAYS`).
- **Migrations to amend:** `supabase/migrations/20260422000001_create_member_with_cycle.sql`, `20260424000001_restart_member_cycle.sql`, `20260514000005_commit_cycle_settlement.sql`, `20260427000002_record_advance.sql`, `20260425000005_record_contribution.sql`; schema constraint at `20260419000001_init_schema.sql:139`.
- **Existing contract-test pattern to mirror:** `supabase/functions/_shared/record-advance.contract.test.ts`, `supabase/functions/_shared/undo-transaction.contract.test.ts`.
- **Memory:**
  - `feedback_migration_rpc_smoke_test` — psql / test:edge before push when a migration touches RPC bodies.
  - `project_supabase_rpc_binding` — do not extract `supabase.rpc` into a free variable.
  - `project_views_after_columns` — no new columns here → no view changes.
- **Operating rules:** `CLAUDE.md` § Local-DB workflow (db:migrate, NOT db:reset).

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-05-19 | Winston (architect) | Story 11.3 spec generated by `bmad-create-story`. Third story of Epic 11. Single SQL migration: new `derive_cycle_bounds(date)` helper mirroring the TS `deriveCycleBounds`; `create_member_with_cycle` + `restart_member_cycle` use it; `commit_cycle_settlement` payout recompute + `record_advance` capacity become `× (cycleLength − 1)` derived from `end_date − start_date + 1`; `cycle_day` ceiling raised 30 → 31 across the DB column check, `record_contribution` + `record_advance` validations, AND the Zod `transactionRowSchema.cycle_day` in `src/features/member/types.ts:68`. New Deno contract test cross-checks SQL vs TS bounds derivation. Scope absorbs the items the 11.2 code-review handoff identified (`record_advance` + `cycle_day` ceiling), in addition to the original `commit_cycle_settlement` work. Legacy 30-day cycles unchanged — no backfill. Closes Epic 11's data path; Story 11.4 (SMS / receipt copy) follows. Status → ready-for-dev. |
