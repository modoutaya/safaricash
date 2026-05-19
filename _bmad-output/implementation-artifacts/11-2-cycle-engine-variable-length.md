# Story 11.2: Cycle engine refactor to variable-length cycles

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer**,
I want **`src/domain/cycle/cycleEngine.ts` refactored so cycle length is derived per-cycle from `start_date`/`end_date` instead of the hardcoded `CYCLE_TOTAL_DAYS = 30`**,
so that **projection, advance-capacity, settlement, and day-N math are correct for partial and full-month calendar cycles (FR16, FR17, NFR-R3) — implementing ADR-004 Amendment A1.**

> **This story touches code.** It is gated by Story 11.1 (ADR-004 Amendment A1 — **merged**, PR #116). The amendment's invariants INV-1…INV-9 are the authoritative contract; this story makes the engine satisfy them.
>
> **Leave the build green.** Removing `CYCLE_TOTAL_DAYS` / `CONTRIBUTION_DAYS` and changing function signatures breaks ~8 consumer files at compile time. This story MUST update every call site so `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` all pass. A story that leaves `main` un-compilable is not done.
>
> **Scope boundary vs Story 11.4.** This story owns the engine + every TypeScript call site needed for a green build + correct cycle math. Story 11.4 owns only the **display copy that compiles fine but shows a wrong number**: the `jour {cycleDay}/30` string literal in `shareReceipt.ts` and the server-side `format_sms_body` SQL denominator. See Dev Notes § "Scope clarification" — this is a deliberate, documented refinement of the Sprint Change Proposal's terser 11.2/11.4 split (the proposal's split would leave the build broken between the two PRs).

## Context

ADR-004 Amendment A1 (`docs/ADR/004-cycle-invariants.md` § Amendment A1) replaced the fixed 30-day cycle with a calendar-month-aligned, variable-length cycle. The engine still hardcodes the old model:

- `cycleEngine.ts:14-16` — `CYCLE_TOTAL_DAYS = 30`, `COMMISSION_DAYS = 1`, `CONTRIBUTION_DAYS = 29`.
- `computeProjectedFinalBalance`, `canAcceptAdvance`, `settle` all use `CONTRIBUTION_DAYS` (29).
- `cycleDay` clamps to `[1, 30]`; `daysUntilCycleEnd` / `isCycleInUpcomingEndWindow` use `CYCLE_TOTAL_DAYS`.
- `isSettlementReady` is `start_date + 29 days` based.
- `computeMemberStats` derives `daysRemaining = CYCLE_TOTAL_DAYS - day`.

The `cycles` table already has `start_date` AND `end_date` columns (`init_schema.sql:111-112`), and the member/profile queries already `select` `end_date` (`useMembers.ts:127`, `useMemberProfile.ts:69`) — so **no new query columns are needed**; the data is available, it just is not threaded into the engine.

## Acceptance Criteria

> Numbered for traceability. **Given/When/Then** lines are the BDD source from `epics.md` Story 11.2; the rest are spec-derived constraints. The authoritative invariant definitions are ADR-004 Amendment A1 — cite it, do not re-derive.

1. **Constants.** **Given** the cycle engine module, **When** the refactor lands, **Then** `CYCLE_TOTAL_DAYS` and `CONTRIBUTION_DAYS` are **removed** from `cycleEngine.ts` and from the `index.ts` barrel. `COMMISSION_DAYS = 1` stays (commission is still one day). A new exported `const MIN_CYCLE_LENGTH_DAYS = 3` is added (ADR A1.5 — single point of edit, mirroring `DEFAULT_CYCLE_ENDING_WINDOW_DAYS`).

2. **`cycleLengthDays` helper.** **Then** a pure `cycleLengthDays(startDate: string, endDate: string): number` is added, returning `end − start + 1` (inclusive, UTC date math — mirror `cycleDay`'s existing `T00:00:00Z` parsing). `contributionDays` is always `cycleLengthDays(...) − 1`.

3. **`deriveCycleBounds` (INV-9).** **Then** a pure `deriveCycleBounds(requestedDate: string): { startDate: string; endDate: string }` is added implementing ADR A1.4 INV-9: `endDate` = last calendar day of `month(requestedDate)`; if `endDate − requestedDate + 1 < MIN_CYCLE_LENGTH_DAYS`, roll forward (`startDate` = 1st of next month — year-aware Dec→Jan, `endDate` = its last day). This is the **canonical reference implementation**; Story 11.3's SQL RPC must mirror it and carry a contract test cross-checking the two (noted for 11.3, not built here).

4. **`computeProjectedFinalBalance` — FR17.** **Then** the signature gains `contributionDays`: `computeProjectedFinalBalance(dailyAmount, advancesSoFar, contributionDays)` returns `dailyAmount × contributionDays − advancesSoFar` as an integer. The old `dailyAmount × 29 − advances` form is gone. (INV-1: result is independent of `cycleDay`.)

5. **`settle` — INV-2 / NFR-R3.** **Then** `settle(dailyAmount, advances, contributionDays)` returns `computeProjectedFinalBalance(dailyAmount, Σ(advances), contributionDays)` — it MUST mirror `computeProjectedFinalBalance` so settled ≡ projected at cycle end holds by construction (ADR INV-2).

6. **`canAcceptAdvance` — INV-3.** **Then** `canAcceptAdvance(dailyAmount, existingAdvances, newAdvance, contributionDays)` accepts iff `Σ(existing) + newAdvance ≤ dailyAmount × contributionDays`. Strict `≤` at the boundary preserved.

7. **`commission` — INV-4 unchanged.** **Then** `commission(dailyAmount)` still returns `dailyAmount × COMMISSION_DAYS` = `1 × dailyAmount`, for **every** cycle length. No proration, no new parameter. (ADR A1.3 INV-4 — the property that keeps INV-8 true.)

8. **`cycleDay` — INV-5.** **Then** the signature becomes `cycleDay(startDate, endDate, now)`; the function derives `cycleLength = cycleLengthDays(startDate, endDate)` internally and clamps to `[1, cycleLength]` (was `[1, 30]`). `now` before `startDate` → 1; `now` after `endDate` → `cycleLength`. INV-6 (monotonicity) must still hold.

9. **`isSettlementReady`.** **Then** it becomes `endDate`-based: `isSettlementReady(now, endDate)` is true iff `now` is on or after `endDate` (the cycle's last day). The old `start_date + 29 days` form is gone.

10. **`daysUntilCycleEnd` / `isCycleInUpcomingEndWindow`.** **Then** both take the cycle length: `daysUntilCycleEnd(cycleDayValue, cycleLength)` = `max(0, cycleLength − cycleDayValue)`; `isCycleInUpcomingEndWindow(cycleDayValue, windowDays, cycleLength)` consumes it. `DEFAULT_CYCLE_ENDING_WINDOW_DAYS` and `RATTRAPAGE_DAY_OPTIONS` are unchanged.

11. **`computeMemberStats`.** **Then** the `currentCycle` parameter shape gains `endDate`: `{ startDate: string; endDate: string } | null`. `MemberStats.cycleDay` uses `cycleDay(startDate, endDate, now)`; `daysRemaining` = `daysUntilCycleEnd(cycleDay, cycleLength)`; `projectedFinalBalance` uses `computeProjectedFinalBalance(dailyAmount, outstandingAdvances, cycleLength − 1)`.

12. **Property tests re-written — ADR A1.6.** **And** all invariants from ADR-004 Amendment A1 are verified via `fast-check`. **Then** `cycleEngine.test.ts` implements the A1.6 skeletons: `propProjectedBalanceTimeInvariance` (INV-1), `propSettledEqualsProjectedAtCycleEnd` (INV-2 — **renamed** from `propSettledEqualsProjectedAtDay30`), `propAdvanceCapacityBound` (INV-3), `propCommissionInvariance` (INV-4), `propCycleDayClamped` (INV-5), `propCycleDayMonotonic` (INV-6), `propSettlementDeterministic` (INV-7), `propIntegerFcfaOutputs` (INV-8), and the new `propCycleBoundsDerivation` (INV-9). `cycleLength` arbitraries use `{ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }` — never the literal `3`.

13. **Legacy-cycle test case — ADR A1.7.** **Then** the property/example tests include an explicit `cycleLength = 30` case (a legacy row where `endDate = startDate + 29 days`) asserting the engine degrades exactly to the original 30-day numbers — locking backward compatibility for un-migrated rows.

14. **100 % coverage gate.** **And** statement + branch + function coverage on `src/domain/cycle/` stays at **100 %**, gated by `npm run test -- --coverage`. Run coverage locally before pushing (`feedback_run_coverage_locally`).

15. **All consumer call sites updated — build green.** **And** every consumer of a changed signature is updated so `typecheck` / `lint` / `test` / `build` pass. The known surface (verify exhaustively — do not trust this list as complete):
    - **Engine-constant consumers:** `src/app/routes/members/[id].transaction.tsx:91`, `src/features/transaction/ui/AdvanceFlow.tsx:116`, `src/features/member/ui/MemberForm.tsx:98`, `src/components/domain/AdvanceSimulationPanel.tsx:60` — all import `CYCLE_TOTAL_DAYS`.
    - **Signature-changed fn calls:** `computeProjectedFinalBalance` — `MemberForm.tsx:102`, `useMembers.ts:91`, `deriveExportRows.ts:88`, `AdvanceSimulationPanel.tsx:64`; `canAcceptAdvance` — `AdvanceSimulationPanel.tsx:42`; `settle` — `[id].settlement.tsx:124`, `SettlementSummaryCard.tsx:72`; `computeMemberStats` — `optimisticCache.ts:95`, `useMemberProfile.ts:110`.
    - **Local hardcoded `30` duplicates** (not engine imports, but encode the same wrong assumption — fix as part of correctness): `src/features/member/ui/MemberCard.tsx:25` and `src/features/member/api/useMembers.ts:34` each declare a local `const CYCLE_TOTAL_DAYS = 30`; `useMembers.ts:48-51` `computeCycleDay` clamps to 30.
    - Each consumer must source `endDate` / `cycleLength` from data it already has — the cycle row's `end_date` (queries already select it; see Context). Where a derived view-model type lacks it (e.g. `MemberProfile.currentCycle` is `{ id, startDate, dayNumber }` — `src/features/member/types.ts:99`), add `endDate`.

16. **Consumer & engine tests updated.** **Then** every test that asserts the old `× 29` / `/30` math is updated: at minimum `deriveExportRows.test.ts` (lines 74/84/106), `SettlementSummaryCard.test.tsx:61-64`, `[id].settlement.test.tsx:180`, plus any `cycleDay`/`computeMemberStats` consumer tests. Grep for stale `× 29`, `* 29`, `/30`, `× 30` assertions (`feedback_push_then_ci_failure`).

17. **No new dependencies, no migrations, no engine infrastructure imports.** **And** the engine keeps zero imports from `src/infrastructure/`, `src/features/`, React, or i18n (ADR-004 Decision #6 / INV-7). No `package.json` change (`fast-check` already installed).

18. **Scope exclusions.** Story 11.2 does **not** touch: the SQL RPCs (`create_member_with_cycle`, `restart_member_cycle`, `commit_cycle_settlement` — Story 11.3); the `jour {cycleDay}/30` display string in `shareReceipt.ts:50` and the server `format_sms_body` denominator (Story 11.4). If a `/30` appears in non-display **math**, it is in scope; if it is purely a displayed string, it is 11.4.

## Tasks / Subtasks

- [x] **Task 0 — Read the inputs.** Re-read `docs/ADR/004-cycle-invariants.md` § Amendment A1 (INV-1…INV-9, A1.5 constant, A1.6 skeletons, A1.7 legacy note), the current `src/domain/cycle/cycleEngine.ts` + `cycleEngine.test.ts`, and `epics.md` Story 11.2. Confirm the locked model before editing.

- [x] **Task 1 — Engine constants + new helpers (AC #1 #2 #3).** In `cycleEngine.ts`: remove `CYCLE_TOTAL_DAYS` / `CONTRIBUTION_DAYS`; keep `COMMISSION_DAYS`; add `MIN_CYCLE_LENGTH_DAYS = 3`, `cycleLengthDays`, `deriveCycleBounds`. Update `index.ts` barrel exports.

- [x] **Task 2 — Re-parameterize the math functions (AC #4 #5 #6 #7).** `computeProjectedFinalBalance`, `settle`, `canAcceptAdvance` gain `contributionDays`; `settle` mirrors `computeProjectedFinalBalance` (INV-2). `commission` unchanged.

- [x] **Task 3 — Re-parameterize the day functions (AC #8 #9 #10 #11).** `cycleDay(start, end, now)`; `isSettlementReady(now, endDate)`; `daysUntilCycleEnd` / `isCycleInUpcomingEndWindow` gain `cycleLength`; `computeMemberStats` `currentCycle` shape gains `endDate`.

- [x] **Task 4 — Property tests (AC #12 #13).** Rewrite `cycleEngine.test.ts`: 9 `fast-check` property tests per ADR A1.6 (skeleton names verbatim, INV-2 renamed), `cycleLength` arbitraries `{ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }`, plus the explicit `cycleLength = 30` legacy case + example tests for the worked example (registered the 7th → cycleLength 24, payout `dailyAmount × 23`).

- [x] **Task 5 — Update consumer call sites (AC #15 #16).** Update every file in AC #15. Thread `endDate` from the cycle row through view-model types where needed. Replace the local `CYCLE_TOTAL_DAYS = 30` duplicates in `MemberCard.tsx` / `useMembers.ts` with engine-derived length. Update consumer tests asserting old math.

- [x] **Task 6 — All gates.**
  - `npm run typecheck` (clean).
  - `npm run lint` (`--max-warnings=0`).
  - `npm run test -- --coverage` (all pass; `src/domain/cycle/` at **100 %**; global branches ≥ 75 %).
  - `npm run build`.

- [x] **Task 7 — LOCAL Playwright sanity.** `npx playwright test` — cycle-day display and advance/settlement flows must still pass. Update any E2E asserting a `/30` denominator that is now data-driven.

- [x] **Task 8 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `11-2-cycle-engine-variable-length: ready-for-dev` → `review`.

## Dev Notes

### Architecture compliance

- **Layering.** `cycleEngine.ts` stays a pure function library — zero `infrastructure/` / `features/` / React / i18n imports (ADR-004 Decision #6, INV-7). `deriveCycleBounds` and `cycleLengthDays` are pure scalar/string in, scalar/record out.
- **Single source of truth.** `deriveCycleBounds` is the canonical cycle-bounds derivation. Story 11.3's SQL RPC mirrors it; 11.3 must add a contract test cross-checking SQL output against this TS function (same pattern as `settle()` ↔ `commit_cycle_settlement`). Flag this in the 11.2 → 11.3 handoff; do not build the SQL side here.
- **Tokens / strict TS.** No `as` casts; the new function signatures are explicit. UTC date math throughout (`T00:00:00Z`) — mirror the existing `cycleDay` parsing; DST must stay invisible.
- **Cite sources.** Engine + test changes cite ADR-004 § Amendment A1 invariant IDs in comments.

### Scope clarification — why 11.2 absorbs call-site updates the Sprint Change Proposal listed under 11.4

The Sprint Change Proposal §3 split "engine" (11.2) and "consumers" (11.4). Taken literally, that leaves `main` un-compilable between the two PRs — removing `CYCLE_TOTAL_DAYS` and changing signatures breaks ~8 files at `tsc` time. A story must never leave the build broken. Resolution: **11.2 = engine + every TypeScript call site required for a green build and correct cycle math.** Story 11.4 shrinks to the genuinely display-only, compile-safe items: the `jour {cycleDay}/30` string literal in `shareReceipt.ts:50` and the server-side `format_sms_body` SQL denominator. Both compile and run fine with a stale `/30`; they only render a wrong number — that is a copy fix, correctly deferred. This refinement was made at story-creation time; it does not require re-running correct-course.

### Engine API — recommended signatures (illustrative — ADR says signatures are implementation-defined)

```
MIN_CYCLE_LENGTH_DAYS = 3
cycleLengthDays(startDate: string, endDate: string): number            // end − start + 1
deriveCycleBounds(requestedDate: string): { startDate; endDate }        // INV-9
commission(dailyAmount): number                                        // UNCHANGED — 1 × dailyAmount
computeProjectedFinalBalance(dailyAmount, advancesSoFar, contributionDays): number
settle(dailyAmount, advances, contributionDays): number                // mirrors computeProjectedFinalBalance
canAcceptAdvance(dailyAmount, existingAdvances, newAdvance, contributionDays): boolean
cycleDay(startDate: string, endDate: string, now: Date): number        // clamp [1, cycleLength]
isSettlementReady(now: Date, endDate: string): boolean
daysUntilCycleEnd(cycleDayValue, cycleLength): number
isCycleInUpcomingEndWindow(cycleDayValue, windowDays, cycleLength): boolean
computeMemberStats(transactions, member, currentCycle: {startDate; endDate} | null, now)
```

### Consumer data flow — `endDate` is already loaded

The `cycles` queries already `select` `end_date` (`useMembers.ts:127`, `useMemberProfile.ts:69`) — **no new query columns**. The work is threading `end_date` from the loaded row into the derived view-model types and engine calls. `src/features/member/types.ts:99` `currentCycle: { id; startDate; dayNumber }` needs `endDate` added; check every place that constructs a `currentCycle` / `MemberStats` input.

### Worked example (must be an example test)

Member registered the 7th of a 30-day month → `deriveCycleBounds` → `startDate` = the 7th, `endDate` = the 30th → `cycleLengthDays` = 24 → `contributionDays` = 23 → `computeProjectedFinalBalance(dailyAmount, 0, 23)` = `dailyAmount × 23`. Legacy row (`endDate = startDate + 29`) → `cycleLengthDays` = 30 → `contributionDays` = 29 → original numbers.

### Anti-patterns (do NOT do)

- **Do NOT keep `CYCLE_TOTAL_DAYS` / `CONTRIBUTION_DAYS` as deprecated re-exports** or back-compat shims. Delete them; fix the call sites.
- **Do NOT prorate the commission.** INV-4 is unchanged — `1 × dailyAmount` always, partial cycles included. Proration introduces division → breaks INV-8.
- **Do NOT touch the SQL RPCs** (`create_member_with_cycle`, `restart_member_cycle`, `commit_cycle_settlement`) — Story 11.3.
- **Do NOT fix the `jour X/30` display string** in `shareReceipt.ts` or the server `format_sms_body` — Story 11.4.
- **Do NOT leave the build broken.** If a consumer is hard to update, that is in scope, not a reason to defer.
- **Do NOT add a dependency.** `fast-check` is already installed.
- **Do NOT introduce floating-point math.** All amounts integer FCFA (INV-8); `deriveCycleBounds` uses integer date arithmetic.
- **Do NOT skip the `cycleLength = 30` legacy test** — it is the guarantee that un-migrated rows still settle correctly.

### Definition-of-done checklist

- All 18 ACs satisfied + all 8 tasks ticked.
- `CYCLE_TOTAL_DAYS` / `CONTRIBUTION_DAYS` gone from engine + barrel + all consumers (incl. the two local duplicates).
- 9 `fast-check` property tests present, skeleton names per ADR A1.6 (INV-2 renamed `propSettledEqualsProjectedAtCycleEnd`); explicit `cycleLength = 30` legacy case.
- `npm run typecheck` / `lint` / `test --coverage` / `build` all green; `src/domain/cycle/` at 100 %; global branches ≥ 75 %.
- `npx playwright test` green locally before push.
- No stale `× 29` / `× 30` / `/30` math assertions remain (grep-verified).
- Story status → `review`; `sprint-status.yaml` updated.
- Zero new dependencies, zero migrations, zero SQL changes.

### Project Structure Notes

- Engine + test stay co-located at `src/domain/cycle/cycleEngine.ts` + `.test.ts` (architecture lines 887-892).
- `src/domain/cycle/index.ts` barrel: drop `CYCLE_TOTAL_DAYS` / `CONTRIBUTION_DAYS`, add `MIN_CYCLE_LENGTH_DAYS`, `cycleLengthDays`, `deriveCycleBounds`.
- Consumer edits span `src/app/routes/members/`, `src/features/{member,transaction,cycle,export,settlement}/`, `src/components/domain/` — all existing files; no new files except possibly nothing.

## References

- **ADR (authoritative invariant contract):** `docs/ADR/004-cycle-invariants.md` § Amendment A1 (INV-1…INV-9, A1.5 `MIN_CYCLE_LENGTH_DAYS`, A1.6 skeletons, A1.7 legacy compatibility).
- **Sprint Change Proposal:** `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-19.md` §4.6 (engine + consumers).
- **Epic + story:** `_bmad-output/planning-artifacts/epics.md` — Epic 11, Story 11.2.
- **Predecessor story:** `_bmad-output/implementation-artifacts/11-1-adr-004-variable-length-amendment.md` (the ADR amendment this story implements).
- **Engine to refactor:** `src/domain/cycle/cycleEngine.ts` + `cycleEngine.test.ts` + `src/domain/cycle/index.ts`.
- **Original engine story (pattern precedent):** `_bmad-output/implementation-artifacts/3-2-cycle-engine-pure-module.md`.
- **PRD:** `_bmad-output/planning-artifacts/prd.md` — FR16, FR17 (lines 496-497), NFR-R3 (line 565).
- **Coverage / push discipline:** memory `feedback_run_coverage_locally`, `feedback_push_then_ci_failure`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context) — `bmad-dev-story` workflow, 2026-05-19.

### Debug Log References

- First full-suite run: 2 failures — `MemberForm.test.tsx` (recap total now date-dependent via `deriveCycleBounds(today)`) and `useMembers.test.ts` "clamp" test (fixture had an incoherent 130-day cycle: `start 2026-01-01` + `end 2026-05-10`). Both were stale-test issues, not engine bugs. Fixed: `MemberForm` test pins the clock (`vi.useFakeTimers({ toFake: ["Date"] })` → 2026-04-01, cycleLength 30); `useMembers` clamp test now seeds a coherent 30-day cycle.

### Completion Notes List

- All 18 ACs satisfied, all 8 tasks complete. `cycleEngine.ts` refactored to variable-length calendar-month cycles per ADR-004 Amendment A1.
- **Engine:** removed `CYCLE_TOTAL_DAYS` / `CONTRIBUTION_DAYS`; kept `COMMISSION_DAYS`; added `MIN_CYCLE_LENGTH_DAYS = 3`, `cycleLengthDays(start, end)`, `deriveCycleBounds(requested)` (INV-9, year-aware roll-forward). `computeProjectedFinalBalance` / `settle` / `canAcceptAdvance` gained `contributionDays`; `cycleDay` gained `endDate`; `isSettlementReady` is now `endDate`-based; `daysUntilCycleEnd` / `isCycleInUpcomingEndWindow` gained `cycleLength`; `computeMemberStats`'s `currentCycle` gained `endDate`. `commission` unchanged (INV-4).
- **Tests:** `cycleEngine.test.ts` rewritten — 9 `fast-check` property tests (INV-1…INV-9, INV-2 renamed `propSettledEqualsProjectedAtCycleEnd`), `cycleLength` arbitraries `{ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }`, explicit `cycleLength = 30` legacy case + worked-example tests. `src/domain/cycle/` coverage **100 %** (stmts/branches/funcs/lines), verified in isolation.
- **Consumers:** view-model `MemberWithMeta.currentCycle` gained `endDate` + `cycleLength`. Updated `useMembers` (removed local `CYCLE_TOTAL_DAYS` / `computeCycleDay` — now engine-derived), `useMemberProfile`, `optimisticCache`, `MemberCard` (removed local `CYCLE_TOTAL_DAYS`), `MemberList`, `selectMembersWithCycleEndingSoon`, `[id].transaction.tsx`, `MemberForm` (`CycleRecap` previews the real first cycle via `deriveCycleBounds(today)`), `AdvanceSimulationPanel` (+`cycleLength` prop), `AdvanceFlow`, `deriveExportRows`, `SettlementSummaryCard`, `[id].settlement.tsx`. 9 consumer test files updated for the new fixture shape / signatures.
- **Gates:** `typecheck` clean, `lint` clean (`--max-warnings=0`), `test --coverage` 1032 passed / 1 skipped (cycle domain 100 %, global branches 76.98 % ≥ 75 %), `build` green (precache 860.75 KiB).
- **Playwright (Task 7) — deferred to CI.** `.env.local` has no `SUPABASE_TEST_*` vars, so the `seededCollector`-gated E2E specs would `test.skip` locally rather than truly run — consistent with the Stories 7.4/7.5 precedent (CI wires `SUPABASE_TEST_SEED_READY`). **Verified the E2E specs need no changes:** the seed fixture (`tests/e2e/fixtures/seed-collector.ts:142`) creates `cycleEnd = cycleStart + 29 days` → 30-day cycles, so the variable-length engine derives `cycleLength = 30` and every `× 29` / "Jour X sur 30" assertion stays valid. Story 11.3 (not yet shipped) keeps the restart RPC at 30 days, so `flow-2-cycle-restart` is also unaffected.
- Zero new dependencies, zero migrations, zero SQL changes — strict per scope.

### File List

**Modified — engine (3):**
- `src/domain/cycle/cycleEngine.ts`
- `src/domain/cycle/cycleEngine.test.ts`
- `src/domain/cycle/index.ts`

**Modified — consumers (14):**
- `src/features/member/types.ts`
- `src/features/member/api/useMembers.ts`
- `src/features/member/api/useMemberProfile.ts`
- `src/features/transaction/api/optimisticCache.ts`
- `src/features/member/ui/MemberCard.tsx`
- `src/features/member/ui/MemberList.tsx`
- `src/features/cycle/api/selectMembersWithCycleEndingSoon.ts`
- `src/app/routes/members/[id].transaction.tsx`
- `src/features/member/ui/MemberForm.tsx`
- `src/components/domain/AdvanceSimulationPanel.tsx`
- `src/features/transaction/ui/AdvanceFlow.tsx`
- `src/features/export/api/deriveExportRows.ts`
- `src/components/domain/SettlementSummaryCard.tsx`
- `src/app/routes/members/[id].settlement.tsx`

**Modified — consumer tests (9):**
- `src/features/cycle/api/selectMembersWithCycleEndingSoon.test.ts`
- `src/features/cycle/api/useCyclesEndingAlert.test.tsx`
- `src/features/member/ui/MemberCard.test.tsx`
- `src/features/member/ui/MemberList.test.tsx`
- `src/app/routes/members/[id].transaction.test.tsx`
- `src/components/domain/AdvanceSimulationPanel.test.tsx`
- `src/components/domain/SettlementSummaryCard.test.tsx`
- `src/features/member/ui/MemberForm.test.tsx`
- `src/features/member/api/useMembers.test.ts`

**Modified — tracking (1):** `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-05-19 | Winston (architect) | Story 11.2 spec generated by `bmad-create-story`. Second story of Epic 11. Refactors `cycleEngine.ts` to variable-length calendar-month cycles per the merged ADR-004 Amendment A1: removes `CYCLE_TOTAL_DAYS`/`CONTRIBUTION_DAYS`, adds `MIN_CYCLE_LENGTH_DAYS` + `cycleLengthDays` + `deriveCycleBounds`, threads `contributionDays`/`endDate` through projection/settle/canAcceptAdvance/cycleDay/computeMemberStats, rewrites the 9 `fast-check` property tests. Scope clarified vs the Sprint Change Proposal: 11.2 absorbs all TypeScript call-site updates (~8 files) to keep the build green; 11.4 keeps only the display-copy `/30` denominator. 100 % coverage gate on `src/domain/cycle/`. Status → ready-for-dev. |
| 2026-05-19 | dev agent | Implementation complete via `bmad-dev-story`. Engine refactored + barrel updated; `cycleEngine.test.ts` rewritten (9 property tests, INV-2 renamed, legacy `cycleLength = 30` case); 14 consumer files + 9 consumer test files updated; `MemberWithMeta.currentCycle` view-model gained `endDate` + `cycleLength`. Two stale tests fixed (`MemberForm` recap pinned clock; `useMembers` clamp test given a coherent fixture). Gates: typecheck / lint / 1032 vitest (cycle domain 100 %) / build all green. Playwright deferred to CI (no `SUPABASE_TEST_*` env locally); E2E specs verified to need no changes (seeds are 30-day cycles). Zero new dependency / migration / SQL. Status → review. |
