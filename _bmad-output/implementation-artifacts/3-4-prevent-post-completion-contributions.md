# Story 3.4: Prevent contributions against a completed cycle

Status: review

## Story

As a **collector**,
I want **the system to reject new contributions on a member whose cycle has completed**,
so that **day-31+ entries don't silently corrupt a settled cycle (FR19).**

> **Predicate of this story.** Story 3.3 (status transitions) shipped the `promote_cycle_on_advance` trigger that flips `active → with_advance`. Story 3.4 adds the **reject** side of the contract: any transaction insert against a `completed` or `settled` cycle MUST be rejected by the database itself, no matter the caller.

## Acceptance Criteria

> Numbered for traceability. Lines beginning with **Given/When/Then** are the BDD source from `epics.md` lines 765-771; the rest are spec-derived constraints required for a flawless implementation.

1. **Server-side rejection.** **Given** a member with cycle status `completed` (or `settled` — the BDD names only `completed` but `settled` is a strict superset and shares the same intent), **When** the collector attempts to record a transaction (`kind ∈ {contribution, rattrapage, advance}`) against that cycle, **Then** the database raises an exception with sqlstate `23514` (check_violation), which PostgREST translates into **HTTP 409 Conflict** with an RFC 7807 `application/problem+json` body.

2. **Trigger location.** A new function `public.reject_transaction_on_closed_cycle()` lives in migration `20260425000004...` and is attached as `BEFORE INSERT FOR EACH ROW` on `public.transactions`. SECURITY DEFINER + `set search_path = public, pg_temp` (mirrors the audit + promote triggers).

3. **All transaction kinds blocked.** The trigger rejects ALL kinds — `contribution`, `rattrapage`, AND `advance`. PRD FR19 uses "contributions" generically (umbrella term for any transaction), and Story 3.3's promote trigger already silently no-ops advances on non-active cycles. Story 3.4 strengthens that to an EXPLICIT 409 — the collector must restart the cycle (Story 2.7's `restart_member_cycle` RPC) to record any new transaction.

4. **Idempotent + transactional.** The trigger fires BEFORE INSERT — if it raises, the row is never inserted, no AFTER triggers fire (audit, promote, etc.), the entire transaction rolls back. No orphan state.

5. **Error payload.** The `RAISE EXCEPTION` includes:
   - **Message:** `cycle_closed: cannot record {kind} on a {status} cycle`
   - **DETAIL:** `cycle_id={uuid} status={status}` (so a debugger can identify the row).
   - **HINT:** `Restart the cycle via restart_member_cycle RPC` (so the collector or future Story 4.1 UI knows the recovery path).
   - **ERRCODE:** `23514` (PostgREST → 409).
   PostgREST exposes all of these in the response body's `message` / `details` / `hint` fields.

6. **No silent acceptance, even from service-role.** The trigger fires regardless of caller role. A future `INSERT INTO transactions ...` from a CRON or admin tool also gets rejected. (Defence-in-depth — if a future bug bypasses the application layer, the DB still protects the invariant.)

7. **No false positives on active / with_advance cycles.** Inserts on `active` or `with_advance` cycles MUST succeed unchanged. Story 3.3's promote trigger continues to function (BEFORE INSERT runs first, then the row is inserted, then AFTER INSERT promote_cycle_on_advance fires — no conflict).

8. **Pure helper for Story 4.x consumers.** Add `isCycleClosedForTransactions(cycle: { status: CycleStatus } | null): boolean` to `src/domain/cycle/cycleEngine.ts`. Returns `true` iff `cycle?.status` is `completed` or `settled`. Story 4.1's MemberActionSheet (when it lands) imports this to gate the Primary CTA disabled state. Story 3.4 ships the helper + property test; the UI wiring is explicitly Story 4.1's territory.

9. **100 % coverage on the new helper.** The cycle engine module has a 100 % coverage gate (Story 3.2). The new `isCycleClosedForTransactions` adds 1 statement / 1 branch / 1 function — covered by 4 example tests (one per `CycleStatus` enum value: `active`, `with_advance`, `completed`, `settled`) + 1 null-cycle case = 5 tests.

10. **DB contract test.** A new `supabase/functions/_shared/reject-transaction-on-closed-cycle.contract.test.ts` (Deno) asserts:
    - Insert contribution on `active` cycle → succeeds.
    - Insert contribution on `with_advance` cycle → succeeds.
    - Insert contribution on `completed` cycle → 23514 error with the expected message + hint.
    - Insert rattrapage on `completed` cycle → 23514 error.
    - Insert advance on `completed` cycle → 23514 error.
    - Insert advance on `settled` cycle → 23514 error.
    Mirrors the pattern from `promote-cycle-on-advance.contract.test.ts` (Story 3.3).

11. **No frontend route changes.** Story 3.4 does NOT wire any UI tooltip or disabled-CTA state. The BDD line 770-771 references "the UI displays *'Le cycle est clôturé. Redémarrez-en un nouveau pour reprendre les cotisations.'*" and "the Primary CTA on the member action sheet is disabled with an explanatory tooltip" — but the action sheet is Story 4.1's responsibility and doesn't exist yet. The i18n copy + the helper from AC #8 are Story 3.4's contribution to the eventual Story 4.1 surface.

12. **i18n copy ready for Story 4.1.** Add the i18n key `members.profile.cycle_closed_blocked` = "Le cycle est clôturé. Redémarrez-en un nouveau pour reprendre les cotisations." to `src/i18n/fr.json` so it's already typed against `TranslationKey` when Story 4.1 needs it. No JSX consumes it in Story 3.4.

13. **Trigger ordering documentation.** Add a comment in the new migration explaining the BEFORE / AFTER trigger sequence on `transactions`:
    1. **BEFORE INSERT:** `reject_transaction_on_closed_cycle` (Story 3.4) — rejects on closed cycles.
    2. **(INSERT itself)** if the BEFORE trigger didn't raise.
    3. **AFTER INSERT:** `audit_transactions` (Story 1.2) — audit trail.
    4. **AFTER INSERT:** `promote_cycle_on_advance_trigger` (Story 3.3) — status promotion.
    Document this ordering so a future trigger addition slots in the right phase.

## Tasks / Subtasks

- [ ] **Task 0 — Migration: `reject_transaction_on_closed_cycle` trigger (AC #1 #2 #3 #4 #5 #6 #7).** Create `supabase/migrations/20260425000004_reject_transaction_on_closed_cycle.sql`:
  - SECURITY DEFINER function `public.reject_transaction_on_closed_cycle()`.
  - BEFORE INSERT trigger on `public.transactions FOR EACH ROW`.
  - Inside: `SELECT status INTO v_status FROM cycles WHERE id = NEW.cycle_id; IF v_status IN ('completed','settled') THEN RAISE ... USING ERRCODE='23514' ...; END IF; RETURN NEW;`.
  - Comment cites BDD + AC #5 message/detail/hint format + the trigger ordering from AC #13.
  - Apply via `npm run db:migrate` (preserves seeded data per CLAUDE.md).

- [ ] **Task 1 — Domain helper + tests (AC #8 #9).** Edit `src/domain/cycle/cycleEngine.ts`:
  - Add `export function isCycleClosedForTransactions(cycle: { status: CycleStatus } | null): boolean`.
  - Add to the `index.ts` barrel.
  - Edit `cycleEngine.test.ts`: 5 example tests (one per status enum value + the null case). 100 % coverage gate must hold.

- [ ] **Task 2 — DB contract test (AC #10).** Create `supabase/functions/_shared/reject-transaction-on-closed-cycle.contract.test.ts`:
  - Mirror the pattern from `promote-cycle-on-advance.contract.test.ts`.
  - 6 test cases per AC #10.
  - Add the new file path to `scripts/run-edge-tests.sh` (the script enumerates files explicitly).

- [ ] **Task 3 — i18n copy (AC #12).** Add `members.profile.cycle_closed_blocked` to `src/i18n/fr.json`. The TypeScript `TranslationKey` derivation will pick it up automatically.

- [ ] **Task 4 — All gates.**
  - `npm run typecheck` (the helper export change touches the cycle barrel).
  - `npm run lint` (no new warnings).
  - `npm test -- --coverage` (cycle module still 100 % across all 4 metrics).
  - `npm run test:edge` (5 new contract tests pass alongside the existing 20).
  - `npm run build`.

- [ ] **Task 5 — LOCAL Playwright sanity.** Run `npx playwright test`. The existing E2E suite doesn't touch transactions yet, but verify zero regressions on the member surfaces (profile + edit + restart + delete).

- [ ] **Task 6 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `3-4-reject-contributions-on-completed: in-progress` → `review`.
  - Document the deferred frontend (action-sheet disabled state, tooltip wiring) as Story 4.1's responsibility.

## Dev Notes

### Architecture compliance

- **Layering.** DB-only enforcement + 1 pure helper added to `src/domain/cycle/`. No `features/` or `infrastructure/` changes (the helper is consumed but not yet wired by Story 4.1).
- **No new dependencies.** Just SQL + a Deno test + 1 i18n key.
- **Cite sources.** Migration header cites BDD lines 765-771, FR19 (PRD line 499), Story 3.3 + Story 2.7 (the recovery path: restart the cycle).
- **PostgREST 409 mapping.** `architecture.md:356` confirms PostgREST returns standard codes; integrity-violation sqlstates (23xxx) map to 409 Conflict by default.

### Why a BEFORE trigger, not a CHECK constraint

- A CHECK constraint cannot reference another table (`cycles.status`) without a complex sub-query workaround. Triggers are the idiomatic Postgres pattern for cross-table integrity.
- BEFORE INSERT is correct: if it raises, the INSERT never happens, the AFTER triggers (`audit_transactions`, `promote_cycle_on_advance_trigger`) never fire, no orphan audit row. AFTER would still leave dangling state.
- SECURITY DEFINER is required because the trigger might run with the caller's role (which has `SELECT cycles` via RLS) but we want the deterministic check unaffected by RLS edge cases. Mirrors the audit trigger pattern.

### Why all transaction kinds, not just `contribution` / `rattrapage`

PRD FR19 reads: *"prevents new contributions from being recorded against a cycle once it has completed"*. The word "contributions" is umbrella terminology — FR22 explicitly distinguishes contribution / rattrapage / advance under the broader "transaction capture" heading. The intent of FR19 is "no further mutations to a closed cycle". Story 3.3's promote trigger already silently no-ops advances on non-active cycles; Story 3.4 strengthens that to an explicit 409 across all kinds.

If a future product decision needs to allow advances on completed cycles (e.g., for late dispute reconciliation), it'll be a deliberate ADR amendment, not a quiet hole in the contract.

### Why the i18n key ships now (without a UI consumer)

The TypeScript `TranslationKey` derivation reads `fr.json` and emits a discriminated union. Story 4.1's MemberActionSheet component will import `t("members.profile.cycle_closed_blocked")`. If the key doesn't exist when Story 4.1 ships, the dev has to add it, which means a coordination dance ("did Story 3.4 add it? did Story 4.1 add it?"). Pre-shipping the key in Story 3.4 makes the contract one-sided: Story 3.4 owns the **what** (the copy), Story 4.1 owns the **where** (the JSX).

The cost is one i18n key sitting unused for one story-cycle. The benefit is zero coordination overhead.

### Anti-patterns (do NOT do)

- **Do NOT downgrade to a CHECK constraint** for "simplicity" — it can't reference `cycles.status` cleanly.
- **Do NOT raise with sqlstate `P0001`** (raise_exception) — PostgREST maps that to 400 Bad Request, not 409 Conflict. The BDD requires 409.
- **Do NOT block kind=advance on `with_advance` cycles** — the cycle is still active for write purposes. Only `completed` and `settled` are gates.
- **Do NOT wire the frontend action sheet** in this story — Story 4.1 owns that surface. The i18n key + helper are the deferred handshake.
- **Do NOT add a separate trigger for advances** — the single trigger handles all kinds via the simple `IF v_status IN ('completed','settled')` check.
- **Do NOT re-implement the trigger as a SECURITY INVOKER function** — it must be SECURITY DEFINER so the SELECT on `cycles` succeeds regardless of RLS policies on the caller's role.

### Edge cases worth testing (covered by Task 2)

- **Insert on `active` cycle:** all kinds succeed.
- **Insert on `with_advance` cycle:** all kinds succeed.
- **Insert contribution on `completed`:** 23514 + the expected message text.
- **Insert rattrapage on `completed`:** 23514.
- **Insert advance on `completed`:** 23514 (Story 3.3's promote trigger never fires because the BEFORE trigger raised first).
- **Insert any kind on `settled`:** 23514.
- **(Implicit) Concurrency:** two concurrent INSERTs against the same just-completed cycle → both rejected. Postgres serialises the row read on `cycles.status`; whichever sees `completed` first triggers the rejection. Both fail.

### Definition-of-done checklist

- All 13 ACs satisfied + all 6 tasks ticked.
- Migration applied via `npm run db:migrate` (preserves seeded data).
- 6 Deno contract tests pass via `npm run test:edge`.
- 5 new vitest tests for `isCycleClosedForTransactions`; cycle module still 100 % coverage.
- i18n key `members.profile.cycle_closed_blocked` lands in `fr.json`.
- `npm run typecheck` / `npm run lint` / `npm run test` / `npm run test:edge` / `npm run build` all green.
- **`npx playwright test` (full suite) green LOCALLY before push** (Story 2.5 discipline).
- Story status set to `review`; sprint-status updated.
- Story file's Dev Notes captures the deferred Story 4.1 wiring (action-sheet tooltip + Primary CTA disabled state).

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 759-771 (Story 3.4 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 499 (FR19 — system prevents new contributions on completed cycle).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md` line 356 (PostgREST returns standard 4xx codes; integrity violations → 409).
- **Schema:**
  - `supabase/migrations/20260419000001_init_schema.sql` lines 105-118 (cycles + cycles_status_enum), lines 130-145 (transactions + kind enum).
- **Companion stories:**
  - Story 3.3 (`supabase/migrations/20260425000003_promote_cycle_on_advance.sql`) — the AFTER INSERT promote trigger that runs only when the BEFORE INSERT in this story doesn't raise.
  - Story 2.7 (`supabase/migrations/20260424000001_restart_member_cycle.sql`) — the recovery RPC the HINT in this story's exception points to.
- **Existing pattern to mirror:**
  - `supabase/functions/_shared/promote-cycle-on-advance.contract.test.ts` (Deno SQL contract test).
- **Cycle engine:** `src/domain/cycle/cycleEngine.ts` (Story 3.2) — extended with `isCycleClosedForTransactions`.
- **Process discipline:** Run Playwright LOCALLY before each push (Story 2.5 retrospective).
- **Local-DB workflow:** `CLAUDE.md` § Local-DB workflow — use `npm run db:migrate` (preserves seeded data) NOT `db:reset`.
- **Layering rules:** `CLAUDE.md` § Operating principles.

## Dev Agent Record

### Completion Notes

- All 13 ACs satisfied. Migration 0022 applied via `npm run db:migrate` (preserved seeded data).
- `reject_transaction_on_closed_cycle` BEFORE INSERT trigger rejects all transaction kinds on completed/settled cycles with sqlstate 23514 + message "cycle_closed: cannot record {kind} on a {status} cycle" + DETAIL + HINT pointing to `restart_member_cycle`.
- `isCycleClosedForTransactions` helper added to the cycle engine. 5 new vitest tests (one per status enum + null case). Cycle module still 100% coverage.
- 6 new Deno contract tests (covering kind × status combinations). All green via `npm run test:edge` (25 total now).
- i18n key `members.profile.cycle_closed_blocked` added to `fr.json` ready for Story 4.1's MemberActionSheet to consume.
- Story 3.3's "advance on completed cycle is a no-op" test was superseded — Story 3.4 now rejects upstream so the no-op behaviour is unobservable. Replaced with an `ignore: true` discoverability marker pointing to the new contract test.
- All gates green: typecheck ✅ / lint ✅ / 418 vitest ✅ / 25 edge ✅ / build ✅ / 18 Playwright validated locally.

### Debug Log

- **`vitest` startup ERR_PACKAGE_PATH_NOT_EXPORTED** after running `npm run test:edge` (same issue as Story 3.3). Workaround: `rm -rf node_modules && npm ci` before `npm test`. Long-term fix would be switching the edge-tests script to `--node-modules-dir=manual` — out of scope.
- **Story 3.3 test failure** uncovered when running edge tests: the `advance on completed cycle is a no-op` test inserted an advance, then asserted no status change. With Story 3.4's BEFORE INSERT trigger now rejecting that path, the INSERT raises and the test crashes. Fix: replaced the test body with an `ignore: true` marker citing the new Story 3.4 contract test that covers the equivalent surface explicitly.

## File List

**New (3 files):**
- `supabase/migrations/20260425000004_reject_transaction_on_closed_cycle.sql`
- `supabase/functions/_shared/reject-transaction-on-closed-cycle.contract.test.ts`

**Modified (6 files):**
- `src/domain/cycle/cycleEngine.ts` (added `isCycleClosedForTransactions`)
- `src/domain/cycle/cycleEngine.test.ts` (5 new example tests)
- `src/domain/cycle/index.ts` (barrel export of the helper)
- `src/i18n/fr.json` (added `members.profile.cycle_closed_blocked`)
- `scripts/run-edge-tests.sh` (added the new contract test path)
- `supabase/functions/_shared/promote-cycle-on-advance.contract.test.ts` (Story 3.3's "advance on completed" test → ignore-marker)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-24 | Winston (architect) | Story 3.4 spec generated by `bmad-create-story`. DB-only enforcement of FR19 — BEFORE INSERT trigger on `transactions` rejects ALL kinds (contribution, rattrapage, advance) on `completed` or `settled` cycles, raising sqlstate 23514 → PostgREST 409 Conflict. Adds a small `isCycleClosedForTransactions` helper to the cycle engine for Story 4.1's MemberActionSheet to consume + an i18n key for the eventual UI tooltip. Frontend wiring (action-sheet disabled state, tooltip) explicitly deferred to Story 4.1. Status → ready-for-dev. |
| 2026-04-24 | dev agent | Implementation complete. Migration 0022 + 6 Deno contract tests + 5 cycle-engine helper tests + 1 i18n key. All gates green: typecheck / lint / 418 vitest / 25 edge / build / 18 Playwright validated locally. Story 3.3's "advance on completed" test superseded — replaced with an ignore-marker. Status → review. |
