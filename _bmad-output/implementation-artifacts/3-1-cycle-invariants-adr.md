# Story 3.1: Cycle-invariants ADR

Status: review

## Story

As a **tech lead**,
I want **the cycle-engine property-based test invariants defined in `docs/ADR/004-cycle-invariants.md` before the engine is coded**,
so that **implementation is guided by explicit correctness rules (AR16).**

> **Scope discipline.** This is a **docs-only** story. Zero `src/` changes, zero migrations, zero new dependencies. Output is a single Markdown file (`docs/ADR/004-cycle-invariants.md`) plus a sprint-status flip. Story 3.2 implements the engine, installs `fast-check`, and writes the actual property tests that reference this ADR's invariants by name.

## Acceptance Criteria

> Numbered for traceability. Lines beginning with **Given/When/Then** are the BDD source from `epics.md` lines 721-726; the rest are spec-derived constraints required for a flawless implementation.

1. **File path + structure.** **Given** the ADR template (mirrors `docs/ADR/001-supabase-vault.md`), **When** the ADR is written, **Then** it lives at `docs/ADR/004-cycle-invariants.md` with the standard front-matter:
   - `Status` (Accepted)
   - `Date` (2026-04-23)
   - `Story` (3.1)
   - `Authors` (dev pairing on Story 3.1)
   - `Supersedes` / `Superseded by` (—/—)
   followed by `## Context`, `## Decision`, `## Invariants`, `## Property test skeletons`, `## Implementation notes`, `## Open questions`, `## References`.

2. **Context section** explains:
   - Why ADR-004 exists: AR16 follow-up + NFR-R3 zero-tolerance gate + the architecture's commitment to 100% coverage on `src/domain/cycle/cycleEngine.ts` without enumerating the specific properties.
   - What "cycle" means concretely (30-calendar-day window, day 1 = `start_date`, day 30 = `start_date + 29 days`, commission = 1 × daily_amount).
   - The PRD/architecture surface area Story 3.2's engine will satisfy: FR15 (cycle initiated on member create / restart), FR16 (day-N tracking from start_date), FR17 (projected balance formula), FR18 (status transitions), FR19 (no contributions post-completion), FR21 (settlement = computed final balance), NFR-R3 (zero-tolerance).

3. **Decision section** states:
   - The cycle engine module (`src/domain/cycle/cycleEngine.ts`) is the **single source of truth** for cycle math. Any divergence between the engine's output and what the UI / SMS / settlement flow displays is a P0 bug.
   - Property-based testing via `fast-check` is the chosen verification strategy (chosen over pure example-based tests because the cycle engine has a 30-day x N-advances state space that example tests can't enumerate exhaustively).
   - 100% statement + branch + function coverage of `src/domain/cycle/` is the CI gate (vitest + v8 coverage).
   - The four BDD-mandated invariants (a/b/c/d) form the **floor**, not the ceiling — additional invariants enumerated in this ADR (cycle-day clamping, day-N monotonicity, commission constancy) carry the same enforcement weight.

4. **Invariants section — minimum 4 BDD-mandated invariants, each with:**
   - **Plain-English statement** — one sentence a non-engineer can grok.
   - **Mathematical formulation** — symbolic, parameterised on `dailyAmount`, `cycleDay`, `contributionsSoFar`, `advancesSoFar`.
   - **Boundary conditions** — what happens at day 1, day 30, advances=0, advances exceeding theoretical max.
   - **Counterexample bug-class** — an example regression this invariant would catch.
   - **Property test skeleton name** — the function name Story 3.2's tests must use.

   The four mandatory invariants:

   - **INV-1 — Projected-balance monotonicity in time.** Holding `dailyAmount` and total advances constant, the projected final balance does NOT change as cycleDay advances day-by-day (it depends on `dailyAmount` and `Σ(advances)`, NOT on `cycleDay`). Skeleton: `propProjectedBalanceTimeInvariance(dailyAmount, advances)`.
   - **INV-2 — Settled balance ≡ projected balance at day 30 for fully-paid cycles.** When all 29 contribution days have been recorded (commission day = day 30 means no contribution that day) AND no advances are outstanding, `settle(...) === computeProjectedFinalBalance(...)`. Zero-tolerance: any deviation is a NFR-R3 P0. Skeleton: `propSettledEqualsProjectedAtDay30(dailyAmount)`.
   - **INV-3 — Advance sum ≤ projected available balance.** A new advance request `a` must satisfy `Σ(existing_advances) + a ≤ dailyAmount × 29 − Σ(existing_advances)` BEFORE the engine accepts it (i.e., the new advance can't push projected_final_balance below 0). Skeleton: `propAdvanceCapacityBound(dailyAmount, existingAdvances, newAdvanceAmount)`.
   - **INV-4 — Commission invariance (exactly 1 × daily_amount).** For any cycle, the commission deducted from the projected balance is **always** `1 × dailyAmount`, regardless of `cycleDay`, regardless of `Σ(advances)`, regardless of whether the cycle has been settled. Skeleton: `propCommissionInvariance(dailyAmount, anyOtherInputs)`.

5. **Additional invariants (recommended, not BDD-mandated)** — also enumerated with the same 5-field structure:
   - **INV-5 — Cycle-day clamping.** `cycleDay ∈ [1, 30]` for any `now ∈ [start_date − 1 day, +∞)`. Days before `start_date` clamp to 1; days after `start_date + 29` clamp to 30. Skeleton: `propCycleDayClamped(startDate, now)`.
   - **INV-6 — Cycle-day monotonicity in real time.** For any two timestamps `t1 < t2`, `cycleDay(start, t1) ≤ cycleDay(start, t2)`. Skeleton: `propCycleDayMonotonic(startDate, t1, t2)`.
   - **INV-7 — Settlement determinism.** Given identical inputs (`dailyAmount`, sorted contributions, sorted advances, `start_date`), `settle(...)` returns the same FCFA integer on every call (no hidden state, no `Date.now()`-style side reads). Skeleton: `propSettlementDeterministic(scenario)`.
   - **INV-8 — Integer FCFA throughout.** Every public function in `cycleEngine.ts` returns an `integer` FCFA value (no decimals, no fractions). The engine never introduces floating-point intermediaries. Skeleton: `propIntegerFcfaOutputs(scenario)`.

6. **Property test skeletons section** — for each invariant, a TypeScript-shaped pseudocode block showing the expected `fast-check` arbitraries + the property body. Example for INV-1:

   ```ts
   // Story 3.2 will implement this in src/domain/cycle/cycleEngine.test.ts
   it("INV-1: projected balance is invariant in cycleDay", () => {
     fc.assert(
       fc.property(
         fc.integer({ min: 100, max: 100_000 }), // dailyAmount
         fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 0, maxLength: 30 }), // advances
         fc.integer({ min: 1, max: 30 }), // cycleDay1
         fc.integer({ min: 1, max: 30 }), // cycleDay2
         (dailyAmount, advances, day1, day2) => {
           const a = computeProjectedFinalBalance(dailyAmount, 0, sum(advances), day1);
           const b = computeProjectedFinalBalance(dailyAmount, 0, sum(advances), day2);
           return a === b;
         },
       ),
     );
   });
   ```

   Each skeleton is **illustrative**, not prescriptive — Story 3.2 may refactor signatures (e.g., a `Scenario` shape that bundles inputs). The invariant ID + name + intent are fixed; the surface is implementation-defined.

7. **Implementation notes section** captures decisions Story 3.2 will need:
   - **`fast-check` version** — recommend the latest stable (≥ 4.x). Add as `devDependencies` only.
   - **Counterexample shrinking** — `fast-check` shrinks failures automatically; tests should NOT add `numRuns` overrides without a documented reason.
   - **Existing prelude** — `src/features/member/api/computeMemberStats.ts` already implements FR17 with a `TODO(Story 3.2)` marker. Story 3.2 moves this function into `cycleEngine.ts` and replaces the import sites. The ADR explicitly notes this superseding.
   - **Out-of-scope for the engine module** — anything that touches `infrastructure/` (Supabase, fetch), React, or i18n. The engine is a pure function library.
   - **Rounding policy** — all amounts are FCFA (whole francs). No fractional FCFA exist in the system. The engine uses plain `number` typed as integer; if a future computation introduces division, round at the boundary using `Math.round(...)` and assert no fractional intermediaries (INV-8).

8. **Open questions section** captures the 1-2 items Story 3.2 must decide (raise before coding, document in 3.2's spec):
   - **Negative projected balance handling** — when `Σ(advances) > dailyAmount × 29`, the formula yields a negative number. Should the engine return the negative value (transparency) OR clamp at 0 (UI-friendly)? Recommend: return the raw value; let the UI decide presentation. INV-3 prevents this in normal flow.
   - **Settlement timing** — at exactly day 30 OR strictly after day 30? Architecture references both; recommend "any time ≥ day 30" so a collector can settle at 23:59 on day 30 if needed.

9. **References section** with file:line citations:
   - PRD § FR15-FR21 lines 495-501
   - PRD § NFR-R3 line 565
   - Architecture § Cycle Management line 44 + 1086 + 1102
   - Architecture § Q-ARCH cycle invariants follow-up line 1272 + 1360
   - Epics § AR16 line 187, Story 3.1 lines 715-726, Story 3.2 lines 728-741
   - Existing prelude: `src/features/member/api/computeMemberStats.ts` (FR17 implementation with `TODO(Story 3.2)` marker)
   - ADR template: `docs/ADR/001-supabase-vault.md`

10. **Length + tone.** The ADR targets ~250-400 lines of Markdown. Tone matches ADR-001 (technical, definitive, written for the dev who will read it 6 months from now). No marketing prose, no hedging where the architecture is firm, explicit "out of scope" calls where it isn't.

## Tasks / Subtasks

- [ ] **Task 0 — Read the inputs.** Re-read PRD § FR15-FR21 (lines 493-501), NFR-R3 (line 565), Architecture § cycle engine references (lines 1272, 1360), epics.md AR16 (line 187), and `src/features/member/api/computeMemberStats.ts` to extract any latent invariants the existing FR17 implementation already encodes.

- [ ] **Task 1 — Write the ADR file.** Create `docs/ADR/004-cycle-invariants.md` matching the structure in AC #1. Mirror the front-matter conventions from ADR-001.

- [ ] **Task 2 — Enumerate the 4 BDD-mandated invariants** (INV-1 through INV-4) with all 5 fields per AC #4.

- [ ] **Task 3 — Enumerate the 4 recommended invariants** (INV-5 through INV-8) with all 5 fields per AC #5.

- [ ] **Task 4 — Write the property test skeletons** in the dedicated section per AC #6 (TypeScript pseudocode, illustrative, fast-check-shaped).

- [ ] **Task 5 — Implementation notes + open questions** per ACs #7 and #8.

- [ ] **Task 6 — References section** with file:line citations per AC #9.

- [ ] **Task 7 — Self-review.** Re-read the ADR with Story 3.2's developer hat on. Each invariant MUST have an unambiguous test name. Each open question MUST have a recommended answer (Story 3.2 can override but starts from a default). The ADR length should land in the 250-400 line target (AC #10).

- [ ] **Task 8 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `3-1-cycle-invariants-adr: in-progress` → `review`.
  - Note this is the kickoff of Epic 3 — flip `epic-3` from `backlog` → `in-progress`.

## Dev Notes

### Architecture compliance

- **Layering.** Docs-only, no layering implications. Story 3.2 (the engine implementation) will own the `domain/cycle/` slot per architecture line 887-892.
- **No new dependencies in this story.** `fast-check` lands in Story 3.2 alongside the actual property tests (architecture line 196 mentions Vitest + Testing Library; fast-check is implicit but uninstalled).
- **Cite sources.** Every invariant in the ADR points back to its PRD/architecture origin via inline citations (`[PRD § FR17]`, `[architecture § line 1272]`, etc.).

### What "property-based testing" means here

`fast-check` (https://github.com/dubzzz/fast-check) generates random inputs satisfying user-defined arbitraries (`fc.integer`, `fc.array`, `fc.record`, …), then asserts a property holds for all generated inputs. When a counterexample is found, fast-check **shrinks** it to a minimal failing case. For the cycle engine:

- Inputs: `dailyAmount` (integer 100..100_000), `contributions` (array of integers), `advances` (array of integers), `cycleDay` (integer 1..30).
- Properties: the 8 invariants listed in this ADR.
- Outputs: each property runs ~100 random scenarios per CI run; failures land with the smallest counterexample for fast triage.

### Anti-patterns (do NOT do)

- **Do NOT add code.** This story is docs-only. Any `src/` change belongs in Story 3.2. The temptation to "just write the engine while I'm here" is a scope-creep trap.
- **Do NOT install `fast-check` in this story.** Story 3.2 owns the install; it's a `package.json` change with implications (lockfile, CI).
- **Do NOT replace the existing `computeMemberStats.ts`** in this story. The TODO marker stays; Story 3.2 does the move.
- **Do NOT write actual `.test.ts` files** referencing fast-check in this story. The skeletons in the ADR are pseudocode in Markdown code fences — not executable. Story 3.2 implements them.
- **Do NOT skip an invariant** because it "feels obvious". INV-4 (commission = exactly 1 × dailyAmount) and INV-8 (integer FCFA throughout) are easy to assume and easy to violate during refactors. Make them explicit so a bot in 6 months can't drift.

### Definition-of-done checklist

- All 10 ACs satisfied + all 8 tasks ticked.
- `docs/ADR/004-cycle-invariants.md` exists, follows the ADR-001 template, lands in the 250-400 line range.
- 8 invariants enumerated (4 BDD-mandated + 4 recommended), each with 5 fields.
- Property test skeletons section has at least 4 illustrative blocks.
- Open questions section has 1-2 items with recommended answers.
- References section cross-checks (every cited file:line actually exists today — no broken refs).
- Story status set to `review`; sprint-status updated; Epic 3 flipped from `backlog` to `in-progress`.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 711-726 (Epic 3 + Story 3.1 BDD), line 187 (AR16 follow-up).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` lines 493-501 (FR15-FR21 cycle management), line 565 (NFR-R3 zero-tolerance gate).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md` line 44 (Cycle Management table row),
  - line 1086 (component-source map for FR15-21),
  - line 1102 (NFR-R3 mapped to `cycleEngine.test.ts`),
  - line 1272 (Q-ARCH cycle invariants follow-up — explicit ADR-004 callout),
  - line 1360 (next-step item: write ADR-004),
  - lines 887-892 (`src/domain/cycle/cycleEngine.ts` + `.test.ts` slot in the project tree).
- **Existing prelude code:** `src/features/member/api/computeMemberStats.ts` (FR17 implemented with `TODO(Story 3.2)` marker that the ADR must acknowledge).
- **ADR template:** `docs/ADR/001-supabase-vault.md` (front-matter + section conventions).
- **Implementation-readiness report:** `_bmad-output/planning-artifacts/implementation-readiness-report-2026-04-19.md` line 539 (next-step ADR-004).
- **Layering rules:** `CLAUDE.md` § Operating principles.

## Dev Agent Record

### Completion Notes

- All 10 ACs satisfied. ADR-004 lands at 355 lines (target was 250-400).
- 8 invariants enumerated: 4 BDD-mandated (INV-1 projected balance time invariance, INV-2 settled ≡ projected at day 30, INV-3 advance capacity bound, INV-4 commission invariance) + 4 recommended (INV-5 cycle-day clamping, INV-6 cycle-day monotonicity in real time, INV-7 settlement determinism, INV-8 integer FCFA throughout).
- Each invariant has 5 fields (statement, mathematical formulation, boundary conditions, counterexample bug-class, property test skeleton name).
- Property test skeletons section has 8 illustrative `fast-check` blocks (one per invariant).
- Open questions: Q1 (negative projected balance — recommend raw value), Q2 (settlement timing — recommend `≥ day 30`).
- References section cross-checks: every cited PRD/architecture/epics line:number is current (verified via `grep` before commit).
- Zero `src/` changes, zero migrations, zero new dependencies — strict docs-only as the spec demanded.

### Debug Log

(none — docs-only story; no test runs, no CI iterations needed)

## File List

**New (1 file):**
- `docs/ADR/004-cycle-invariants.md`

**Modified (1 file):**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip + Epic 3 → in-progress)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-23 | Winston (architect) | Story 3.1 spec generated by `bmad-create-story`. Docs-only; output is a single ADR file (`docs/ADR/004-cycle-invariants.md`) enumerating 8 cycle-engine invariants (4 BDD-mandated + 4 recommended) with property test skeleton names that Story 3.2's tests reference verbatim. Zero code changes, zero migrations, zero new dependencies — `fast-check` lands in Story 3.2 alongside the actual implementation. Status → ready-for-dev. |
| 2026-04-23 | dev agent | Implementation complete. ADR-004 written at 355 lines (target 250-400). 8 invariants × 5 fields each, 8 property test skeletons, open questions answered. Status → review. |
