# Story 3.2: Pure cycle engine module with 100% unit and property-based test coverage

Status: review

## Story

As a **developer**,
I want **a pure domain module (`src/domain/cycle/cycleEngine.ts`) computing projections and settlement math with zero infrastructure imports**,
so that **cycle correctness is independently testable and portable (FR15, FR16, FR17, NFR-R3).**

> **Predicate of this story.** ADR-004 (Story 3.1, merged 2026-04-23) is the contract. Story 3.2 implements the engine that satisfies its 8 invariants and ships the 8 property-tests by their stable skeleton names.

## Acceptance Criteria

> Numbered for traceability. Lines beginning with **Given/When/Then** are the BDD source from `epics.md` lines 734-741; the rest are spec-derived constraints required for a flawless implementation.

1. **Module location.** Engine lives at `src/domain/cycle/cycleEngine.ts` with co-located tests `src/domain/cycle/cycleEngine.test.ts`. Public surface re-exported via `src/domain/cycle/index.ts` (mirror of `src/domain/audit/index.ts` barrel pattern).

2. **Zero infrastructure imports.** `src/domain/cycle/**/*.ts` MUST NOT import from `src/infrastructure/`, `src/features/`, `src/components/`, `src/app/`, React, sonner, supabase-js, or i18n. ESLint enforcement: add a `no-restricted-imports` rule scoped to the cycle directory listing the forbidden paths. Zod is allowed (already used in `src/domain/audit`).

3. **Public API — minimal signatures (Q1 decision, 2026-04-24).** **Given** the cycle engine module, **When** `computeProjectedFinalBalance(dailyAmount, advancesSoFar)` is called, **Then** it returns `(dailyAmount × 30) − (1 × dailyAmount) − Σ(advances)` in FCFA as an integer (BDD line 738 — minimal signature is justified by ADR-004 INV-1: the formula is independent of `cycleDay` and `contributionsSoFar`).

   Public surface (all minimal — only inputs the function actually needs):
   ```ts
   export const CYCLE_TOTAL_DAYS = 30;
   export const COMMISSION_DAYS = 1;
   export const CONTRIBUTION_DAYS = 29;

   export function computeProjectedFinalBalance(dailyAmount: number, advancesSoFar: number): number;
   export function commission(dailyAmount: number): number;
   export function settle(dailyAmount: number, advances: ReadonlyArray<number>): number;
   export function canAcceptAdvance(dailyAmount: number, existingAdvances: ReadonlyArray<number>, newAdvanceAmount: number): boolean;
   export function cycleDay(startDate: string, now: Date): number;
   export function isSettlementReady(now: Date, startDate: string): boolean;
   export function computeMemberStats(
     transactions: ReadonlyArray<{ kind: "contribution" | "rattrapage" | "advance"; amount: number }>,
     member: { dailyAmount: number },
     currentCycle: { startDate: string } | null,
     now?: Date,
   ): MemberStats;
   export interface MemberStats { ... }
   ```
   Array params typed `ReadonlyArray<number>`.

   **Note on ADR-004 INV-1 property test (`propProjectedBalanceTimeInvariance`).** ADR-004 specifies a 4-arg skeleton signature `(dailyAmount, advances, cycleDay1, cycleDay2)`. With the minimal API, INV-1 is now expressed differently: the function doesn't accept `cycleDay`, so the time-invariance property is implicit (the formula has no `cycleDay` arg). The test still exists but asserts the simpler statement: `computeProjectedFinalBalance(d, sum(advs))` returns the same value across N invocations with permuted inputs. The test name + intent stay; the inner property body adapts.

4. **Open questions answered (ADR-004 § Open questions).** The engine adopts both recommended defaults:
   - **Q1 — Negative projected balance:** return the raw value (no clamp at 0). UI decides presentation.
   - **Q2 — Settlement timing:** `settle()` accepts any inputs without rejecting based on `cycleDay`. A separate `isSettlementReady(now, startDate)` predicate is exposed for the future Edge Function (Story 7.x) to gate the actual write — but `settle()` itself is pure arithmetic.

5. **Property tests via `fast-check`.** **Given** the cycle engine module, **When** the test file runs, **Then** all 8 invariants from ADR-004 are verified via fast-check (BDD line 739). The 8 test cases use the exact skeleton names from ADR-004 § Property test skeletons:
   - `propProjectedBalanceTimeInvariance` (INV-1)
   - `propSettledEqualsProjectedAtDay30` (INV-2)
   - `propAdvanceCapacityBound` (INV-3)
   - `propCommissionInvariance` (INV-4)
   - `propCycleDayClamped` (INV-5)
   - `propCycleDayMonotonic` (INV-6)
   - `propSettlementDeterministic` (INV-7)
   - `propIntegerFcfaOutputs` (INV-8)

   Each `it("INV-N: <statement>", ...)` description quotes ADR-004's plain-English statement verbatim so a failure surfaces the invariant name + intent at the test runner's first line.

6. **Example-based tests (in addition to property tests).** Property tests catch unknown-unknowns; example tests catch known-knowns and serve as documentation. Add at minimum:
   - `dailyAmount = 500` + 0 advances → `projected = 14_500`
   - `dailyAmount = 500` + advances `[3000]` → `projected = 11_500`
   - `dailyAmount = 1000` + 29 contributions of 1000 + 0 advances → `settle = 29_000`
   - `cycleDay("2026-04-01", new Date("2026-04-15T12:00:00Z"))` → `15`
   - `cycleDay` with `now` before `startDate` → `1` (clamped)
   - `cycleDay` with `now` 35 days after `startDate` → `30` (clamped)
   - `canAcceptAdvance(500, [], 14_500)` → `true` (exact capacity)
   - `canAcceptAdvance(500, [], 14_501)` → `false` (over by 1 FCFA)

7. **Coverage gate — 100 % on `src/domain/cycle/`.** **And** test coverage on `src/domain/cycle/` is ≥ 100 %, gated by `vitest --coverage` in CI (BDD line 740). Add to `vitest.config.ts`'s thresholds block:

   ```ts
   "src/domain/cycle/**/*.ts": {
     statements: 100,
     branches: 100,
     functions: 100,
     lines: 100,
   },
   ```

   100 % branch coverage forces every `if`, every `||`, every defensive guard to be exercised by a test.

8. **No layering violation.** **And** the engine has no imports from `src/infrastructure/`, `src/features/`, or React (BDD line 741). Enforced by AC #2's ESLint rule + manual code review.

9. **Replace `computeMemberStats` callers.** The engine's `computeMemberStats` export REPLACES `src/features/member/api/computeMemberStats.ts`. After Story 3.2:
   - `src/features/member/api/useMemberProfile.ts` imports `computeMemberStats` from `@/domain/cycle` (not `./computeMemberStats`).
   - `src/features/member/api/computeMemberStats.ts` and its `.test.ts` are **deleted** (the TODO marker established in Story 2.4 lands here).
   - Behaviour at the UI layer is byte-equivalent — verified by the existing `useMemberProfile.test.tsx` continuing to pass without modification.

10. **`fast-check` install.** Add `fast-check` (latest stable, ≥ 4.x) as `devDependencies` only. NEVER imported from `src/` non-test files. The lockfile change MUST be regenerated under `nvm use 22` per the project's existing memory.

11. **ESLint rule.** Add a `no-restricted-imports` guard scoped to `src/domain/cycle/**/*.ts` (excluding `*.test.ts`):

    ```js
    "no-restricted-imports": ["error", { patterns: [
      "@/infrastructure/*", "@/features/*", "@/components/*", "@/app/*",
      "react", "react-dom", "sonner", "@supabase/*",
    ]}]
    ```

12. **Determinism — no `Date.now()` inside the engine.** ADR-004 INV-7 forbids ambient state reads. `cycleDay(startDate, now)` accepts `now` as an explicit argument (caller-supplied). The same applies to `computeMemberStats(... , now?)` — when omitted, defaults to `new Date()` AT THE BOUNDARY (the parameter default), which is the only acceptable form.

13. **TypeScript strictness.** All public-API parameters typed as `number` (FCFA integers). No `bigint`, no `string | number` unions. The engine assumes its inputs are validated upstream (Zod on PostgREST boundaries; `members.daily_amount` already constrained 100–100_000 by the `update_member` / `create_member_with_cycle` RPCs).

14. **No silent rounding.** Every arithmetic path is integer × integer → integer. No `* 0.5`, no `Math.floor(x / 2)` where `x` is odd, no division. INV-8's property test catches drift.

## Tasks / Subtasks

- [ ] **Task 0 — Install `fast-check`.** Switch to Node 22 (`nvm use 22`), `npm install --save-dev fast-check@latest`, regenerate the lockfile under the right Node version.

- [ ] **Task 1 — Module skeleton (AC #1 #2 #3 #4 #13).** Create `src/domain/cycle/cycleEngine.ts` with the public API stubs from AC #3. Add `src/domain/cycle/index.ts` re-exporting the public surface. Replace the placeholder `.gitkeep`.

- [ ] **Task 2 — `cycleDay` (AC #3 — INV-5/INV-6).** Implement with UTC-anchored Date math. Lift the implementation from `src/features/member/api/computeMemberStats.ts` (the existing `computeCycleDay` helper — the math is already correct, just needs to move + become an exported public function).

- [ ] **Task 3 — `commission` + `computeProjectedFinalBalance` + `canAcceptAdvance` (AC #3 — INV-1/INV-3/INV-4).** Implement the three pure helpers. Each is one-liner-class arithmetic; the work is in the test surface.

- [ ] **Task 4 — `settle` + `isSettlementReady` (AC #3 #4 — INV-2/INV-7).** Implement settlement as `dailyAmount × CONTRIBUTION_DAYS − Σ(advances)` (matches `computeProjectedFinalBalance`, satisfies INV-2). Add `isSettlementReady(now, startDate)` as a pure boolean — Story 7.x's Edge Function gates on it.

- [ ] **Task 5 — `computeMemberStats` move (AC #9).** Move the function from `src/features/member/api/computeMemberStats.ts` to the engine. Re-implement using the engine's primitives. Keep the same `MemberStats` return shape so `useMemberProfile.ts` consumers don't change. Update `useMemberProfile.ts` import. Delete the old file + its test.

- [ ] **Task 6 — Property tests (AC #5).** Create `src/domain/cycle/cycleEngine.test.ts` with 8 `it("INV-N: <statement>", ...)` blocks, each asserting via `fc.assert(fc.property(...))`. Use the skeleton names from ADR-004 verbatim.

- [ ] **Task 7 — Example tests (AC #6).** Add 8+ `it("...", () => { ... })` blocks asserting deterministic example values.

- [ ] **Task 8 — Coverage gate (AC #7).** Edit `vitest.config.ts`'s `thresholds` block to add the `src/domain/cycle/**/*.ts` 100/100/100/100 entry. Run `npm test -- --coverage` and confirm.

- [ ] **Task 9 — ESLint guard (AC #2 #11).** Add the `no-restricted-imports` rule. Run `npm run lint`; no warnings.

- [ ] **Task 10 — Regression sweep.** Run `npm test` (all suites). Confirm `useMemberProfile.test.tsx` + `MemberProfile.test.tsx` + the route tests all still pass with the engine swap.

- [ ] **Task 11 — LOCAL Playwright sanity.** Run `npx playwright test` (full suite) to confirm zero regressions on the E2E surface.

- [ ] **Task 12 — Hygiene + status flip.** Story file: Completion Notes + File List + Change Log. `sprint-status.yaml`: `3-2-cycle-engine-pure: in-progress` → `review`.

## Dev Notes

### Architecture compliance

- **Layering.** New code lives in `src/domain/cycle/` — the architecture's reserved slot per `architecture.md:887-892`. Imports flow inward: `infrastructure` → `features` → `components` may all import `domain`; `domain` imports nothing else.
- **Coverage gate.** Architecture line 245 + 1102 explicitly require 100 % on the cycle engine. Story 1.8 already established the pattern for `domain/audit/**/*.ts` — Story 3.2 mirrors it for `domain/cycle/**/*.ts`.
- **No new shadcn install.** Domain has no UI; this story doesn't touch components.
- **Cite sources.** Engine source comments cite ADR-004 invariant IDs (e.g., `// INV-4: commission constant`) so future reviewers can cross-check.

### Why the public API uses minimal signatures (Q1 decision, 2026-04-24)

ADR-004 INV-1 proves `computeProjectedFinalBalance` is independent of `cycleDay`, and FR17 doesn't reference `contributionsSoFar` either. The user chose the **minimal signature** — only the inputs the function actually uses. Trade-offs accepted:

- **Pro:** the function signature IS the formula; no dead params; impossible to misread.
- **Con:** UI callers that pass 4 values to other helpers must remember not to pass them all here. Mitigated by TypeScript catching extra arguments at compile time.

If a future invariant activates one of the dropped parameters (e.g., a contribution-streak bonus tied to `contributionsSoFar`), it's a one-line signature change — preferred over keeping unused params on the off-chance.

### Why `settle()` mirrors `computeProjectedFinalBalance` exactly

INV-2 requires `settle ≡ projected at day 30 for fully-paid cycles`. The cleanest way to make that property-test pass is to implement `settle()` as the SAME formula. The "what actually was contributed" question is a different concern (Story 7.x reconciliation) — `settle()` here is pure arithmetic on the contractual schedule (29 contributions × dailyAmount − advances).

### Existing prelude — `computeMemberStats.ts` deletion

The file `src/features/member/api/computeMemberStats.ts` (created in Story 2.4) carries:
```ts
// TODO(Story 3.2): move this function to src/domain/cycle/cycleEngine.ts
```
Story 3.2 honours that TODO. The deletion is non-destructive — the engine's `computeMemberStats` export is byte-equivalent at the call site.

### Property-test cookbook

- **`fc.assert(fc.property(arb1, arb2, ..., predicate))`** — predicate returns boolean OR throws.
- **`fc.integer({ min, max })`** for FCFA scalars.
- **`fc.array(fc.integer(...), { minLength, maxLength })`** for transaction lists.
- **`fc.date({ min, max })`** for cycle-day tests; convert to ISO string via `.toISOString().slice(0, 10)`.
- **Default `numRuns`** — fast-check defaults to 100 runs per property; ADR-004 says no overrides without a documented reason.
- **Shrinking** — fast-check shrinks failures automatically.

### Anti-patterns (do NOT do)

- **Do NOT introduce `Date.now()`** anywhere inside `src/domain/cycle/`. INV-7 outlaws it. `now` is always a caller-supplied argument.
- **Do NOT add Supabase, React, or i18n imports.** The ESLint guard catches this; manual review confirms.
- **Do NOT mutate inputs.** All array params are typed `ReadonlyArray<number>`. Use `.reduce`, never `.push`.
- **Do NOT skip a property test** because "the math is obviously right". The 8 invariants are the floor.
- **Do NOT introduce a new public function** without a matching property test.
- **Do NOT keep `src/features/member/api/computeMemberStats.ts` as an alias re-export** "for safety". The engine is the single source of truth. Delete + replace imports.
- **Do NOT downgrade the coverage gate** if a property test reveals an uncovered branch. Add the missing test instead.

### Edge cases the property tests must catch

- **`Σ(advances) > dailyAmount × 29`** — projected balance goes negative. Per Q1, the engine returns the raw negative value. INV-8 confirms it's still an integer.
- **`cycleDay(startDate, now)` with `now < startDate`** — clamps to 1.
- **`cycleDay(startDate, now)` with `now > startDate + 30 days`** — clamps to 30.
- **DST transition** — `cycleDay` uses UTC math, so DST is invisible. Property test with `t1` before DST and `t2` after holds INV-6.
- **Rounding edge** — large dailyAmount + many advances → still integer. INV-8 confirms.

### Definition-of-done checklist

- All 14 ACs satisfied + all 12 tasks ticked.
- `src/domain/cycle/cycleEngine.ts` exists; `index.ts` barrel exports the public surface; test file co-located.
- 8 property tests + 8+ example tests, all green.
- Coverage on `src/domain/cycle/**/*.ts` = 100 % across statements / branches / functions / lines.
- `useMemberProfile.ts` imports `computeMemberStats` from `@/domain/cycle`; old file deleted.
- ESLint guard prevents future regressions to layering.
- `npm run typecheck` / `npm run lint` / `npm run test` / `npm run build` all green.
- **`npx playwright test` (full suite) green LOCALLY before push** (Story 2.5 discipline).
- Story status set to `review`; sprint-status updated.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 728-741 (Story 3.2 BDD).
- **PRD:**
  - `prd.md` lines 495-501 (FR15-FR21 cycle management),
  - line 565 (NFR-R3 zero-tolerance gate).
- **Architecture:**
  - `architecture.md` lines 887-892 (`src/domain/cycle/cycleEngine.ts` + `.test.ts` slot),
  - line 245 (100 % coverage target on cycle engine),
  - line 1086 (component-source map for FR15-21),
  - line 1102 (NFR-R3 mapped to `cycleEngine.test.ts`).
- **ADR-004 — the contract:** `docs/ADR/004-cycle-invariants.md` (Story 3.1, merged 2026-04-23).
  - 8 invariants enumerated;
  - 8 property test skeleton names this story uses verbatim;
  - Open questions Q1 + Q2 — Story 3.2 adopts both recommended defaults.
- **Existing prelude code to move + delete:**
  - `src/features/member/api/computeMemberStats.ts` (carries `TODO(Story 3.2)` marker),
  - `src/features/member/api/computeMemberStats.test.ts` (replaced by the new domain tests).
- **Existing pattern to mirror:**
  - `src/domain/audit/` (module shape + barrel + 100 % coverage gate),
  - `vitest.config.ts:103-108` (existing `domain/audit/**` thresholds — Story 3.2 adds a sibling block).
- **Process discipline:** Run Playwright LOCALLY before each push (lesson from Story 2.5).
- **Layering rules:** `CLAUDE.md` § Operating principles.
- **Memory:** Node 22 + npm 10 for lockfile regeneration.

## Dev Agent Record

### Completion Notes

- All 14 ACs satisfied. `cycleEngine.ts` ships with the **minimal-signature** public API (Q1 decision applied).
- 28 tests in `cycleEngine.test.ts`: 8 property tests (one per ADR-004 invariant, named verbatim from the ADR's skeleton names) + 20 example tests covering boundaries (day-1, day-30, before-startDate clamp, after-cycle clamp, exact capacity, over-by-1 FCFA, etc.).
- **Coverage on `src/domain/cycle/cycleEngine.ts` = 100%** across all 4 metrics (25/25 lines, 8/8 functions, 26/26 statements, 11/11 branches). Verified via `coverage/coverage-summary.json`.
- `computeMemberStats` moved from `features/member/api/` to the domain layer. Old file + its test deleted (the TODO from Story 2.4 honoured). `useMemberProfile.ts` import updated; `MemberStats` type re-exported from features barrel for backwards compat with existing import sites.
- ESLint guard added: `no-restricted-imports` scoped to `src/domain/cycle/**/*.ts` (excluding tests) blocks imports from `infrastructure / features / components / app / i18n / react / supabase / sonner / hookform`.
- Vitest threshold block added for `src/domain/cycle/**/*.ts` mirroring the existing `domain/audit/**/*.ts` 100% gate.
- `fast-check` 4.7.0 installed as `devDependency`. Lockfile regenerated under Node 22.
- All gates green: typecheck ✅ / lint ✅ / 413 vitest ✅ / build ✅ / cycle module 100% / global 76.45% branches > 75%.
- **18/18 Playwright specs validated LOCALLY before push** (Story 2.5 discipline).

### Debug Log

- **`fc.date()` Invalid-Date sentinels** broke INV-5 + INV-6 on the first run. fast-check's `fc.date({ min, max })` can still emit `new Date(NaN)`; the `noInvalidDate: true` option filters them out. Documented inline in the test file.
- **`MemberStats` type duplication** between `features/member/types.ts` (Story 2.4 placeholder) and `domain/cycle/cycleEngine.ts` (canonical). Resolved by deleting the duplicate and re-exporting via `export type { MemberStats } from "@/domain/cycle"` so existing import sites compile unchanged.
- **`coverage --coverage` with a path filter** trips global thresholds (since unrelated files report 0%). Run full coverage via `npm test -- --coverage` (no path filter) — that's how CI runs it too.

## File List

**New (3 files):**
- `src/domain/cycle/cycleEngine.ts`
- `src/domain/cycle/cycleEngine.test.ts`
- `src/domain/cycle/index.ts`

**Modified (5 files):**
- `package.json` + `package-lock.json` (fast-check 4.7.0 devDep)
- `src/features/member/api/useMemberProfile.ts` (import `computeMemberStats` from `@/domain/cycle`)
- `src/features/member/index.ts` (re-export `computeMemberStats` from `@/domain/cycle`)
- `src/features/member/types.ts` (`MemberStats` interface deleted; re-exported from `@/domain/cycle`)
- `vitest.config.ts` (added `src/domain/cycle/**/*.ts` 100% threshold block)
- `.eslintrc.cjs` (added `no-restricted-imports` guard scoped to `src/domain/cycle/`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip)

**Deleted (3 files):**
- `src/features/member/api/computeMemberStats.ts`
- `src/features/member/api/computeMemberStats.test.ts`
- `src/domain/cycle/.gitkeep` (replaced by real files)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-24 | Winston (architect) | Story 3.2 spec generated by `bmad-create-story`. Implements ADR-004's 8 invariants in `src/domain/cycle/cycleEngine.ts` with 100 % coverage gate (statements + branches + functions + lines). Installs `fast-check` as a devDep. Moves the existing `computeMemberStats` helper from `src/features/member/api/` to the domain layer (deleting the old file — its `TODO(Story 3.2)` marker is honoured). Adopts ADR-004's recommended defaults for both open questions: negative projected balance returns raw value, settle() accepts any inputs (separate `isSettlementReady` predicate gates Edge Function writes). Adds an ESLint `no-restricted-imports` guard scoped to `src/domain/cycle/` to prevent future layering regressions. Status → ready-for-dev. |
| 2026-04-24 | dev agent | Implementation complete. 28 tests (8 property + 20 example). Cycle module 100% coverage across all 4 metrics. 413 vitest passing, 18/18 Playwright validated locally before push. Q1 minimal-signature decision applied (`computeProjectedFinalBalance(dailyAmount, advancesSoFar)`). Status → review. |
