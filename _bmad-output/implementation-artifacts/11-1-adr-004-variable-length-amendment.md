# Story 11.1: ADR-004 amendment — variable-length cycle invariants

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **tech lead**,
I want **the cycle-engine invariants in `docs/ADR/004-cycle-invariants.md` amended for variable-length (calendar-month) cycles before the engine is refactored**,
so that **Stories 11.2-11.4 implement against explicit, re-parameterized correctness rules — and the NFR-R3 zero-tolerance gate survives the model change.**

> **Scope discipline — DOCS-ONLY.** This story produces exactly one edited Markdown file (`docs/ADR/004-cycle-invariants.md`) plus a `sprint-status.yaml` flip. **Zero `src/` changes, zero migrations, zero new dependencies, zero test files.** Story 11.2 refactors `cycleEngine.ts` and rewrites the property tests; Story 11.3 owns the RPCs; Story 11.4 owns the consumers. The temptation to "just refactor the engine while I'm here" is a scope-creep trap — INV-4 in this very ADR exists to make such drift visible.
>
> **This story GATES the rest of Epic 11.** 11.2/11.3/11.4 reference the amended invariants by name. Do not start them until this ADR amendment is merged.

## Context

The Sprint Change Proposal `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-19.md` (correct-course 2026-05-19, founder-approved) replaces the fixed 30-calendar-day cycle with a **calendar-month-aligned** cycle. ADR-004's 8 property-based invariants are all written against the hardcoded constants `CYCLE_TOTAL_DAYS = 30` / `CONTRIBUTION_DAYS = 29` and the day range `[1, 30]`. They must be re-parameterized for a per-cycle `cycleLength` before the engine (Story 11.2) is touched, otherwise the property tests would silently encode the old model.

**The new model (decisions locked — do NOT re-litigate in the ADR):**

| Concept | Rule |
|---|---|
| `start_date` | Member registration date (first cycle) or restart date (FR12 restart). |
| `end_date` | Last calendar day of `month(start_date)`. |
| Roll-forward | If `end_date − start_date + 1 < MIN_CYCLE_LENGTH_DAYS` (default **3**), the cycle is rattached to the next month: `start_date` = 1st of next month, `end_date` = last day of next month. |
| `cycleLength` | `end_date − start_date + 1` — inclusive, 1-based, `≥ MIN_CYCLE_LENGTH_DAYS`. |
| `contributionDays` | `cycleLength − 1`. |
| `commission` | `1 × dailyAmount` — **always one full day**, never prorated, on partial cycles included (founder decision 2026-05-19). |
| `projectedFinalBalance` | `dailyAmount × (cycleLength − 1) − Σ(advances)`. |

**Worked example (founder's, must appear in the ADR):** member registered the 7th of a 30-day month → `start_date` = 7th, `end_date` = 30th, `cycleLength` = 24, `contributionDays` = 23, payout = `dailyAmount × 23`.

**Why the "1 full day commission" decision matters for the ADR:** because commission stays a whole `1 × dailyAmount`, **no division is introduced anywhere** — every amount stays an integer. INV-8 (integer FCFA) therefore holds *by construction*, not by luck. The ADR amendment must state this explicitly so a future contributor doesn't "helpfully" prorate the commission and break NFR-R3.

## Acceptance Criteria

> Numbered for traceability. Lines beginning with **Given/When/Then** are the BDD source from `epics.md` Story 11.1; the rest are spec-derived constraints required for a flawless implementation.

1. **File + amendment strategy.** **Given** the existing `docs/ADR/004-cycle-invariants.md` (355 lines, Status: Accepted), **When** the amendment is written, **Then** the original `## Context` / `## Decision` / `## Invariants` / `## Property test skeletons` / `## Implementation notes` / `## Open questions` / `## References` sections are **preserved verbatim for history** (the 30-day model is the record of what shipped in Epic 3), **And** a NEW top-level section `## Amendment A1 — Calendar-Month Variable-Length Cycles (2026-05-19)` is appended after `## References`. The ADR is **amended in place, NOT superseded** — `Superseded by:` stays `—`.

2. **Front-matter update.** **Then** the front-matter gains an `Amended:` line: `**Amended:** 2026-05-19 — Amendment A1 (Story 11.1), calendar-month variable-length cycles`. `Status` stays `Accepted`. `Supersedes` / `Superseded by` stay `—`.

3. **Amendment Context sub-section** explains: the trigger (founder requirement, correct-course 2026-05-19), the new model table (reproduce the table from this story's Context), the founder's worked example (member on the 7th → 23 contribution days), and an explicit pointer to the Sprint Change Proposal as the canonical decision record.

4. **INV-1 — Projected-balance time invariance — AMENDED (formulation only).** **Then** the amendment states INV-1 still holds: projected balance depends only on `dailyAmount` and `Σ(advances)`, not on `cycleDay`. The only change is the `cycleDay` domain: `[1, 30]` → `[1, cycleLength]`. Skeleton name unchanged: `propProjectedBalanceTimeInvariance`.

5. **INV-2 — Settled ≡ projected at cycle end — AMENDED (NFR-R3 gate).** **Then** "day 30" becomes "the cycle's last day (`end_date`)"; for a fully-paid cycle with no advances, `settle(...) ≡ dailyAmount × (cycleLength − 1)`. The amendment **renames the skeleton** `propSettledEqualsProjectedAtDay30` → `propSettledEqualsProjectedAtCycleEnd` and notes Story 11.2 must rename the test accordingly. NFR-R3 zero-tolerance is explicitly reaffirmed for variable length.

6. **INV-3 — Advance capacity bound — AMENDED.** **Then** the capacity bound `dailyAmount × 29` becomes `dailyAmount × (cycleLength − 1)` (i.e., `dailyAmount × contributionDays`). `canAcceptAdvance` accepts iff `Σ(existing) + new ≤ dailyAmount × contributionDays`. Skeleton name unchanged: `propAdvanceCapacityBound` (its arbitraries gain a `cycleLength` input).

7. **INV-4 — Commission invariance — UNCHANGED, with an explicit partial-cycle note.** **Then** the amendment states INV-4 is **NOT amended**: commission is exactly `1 × dailyAmount`, always. **And** it adds a dedicated note: *"A partial first cycle (or a mid-month restart) still takes exactly one full commission day — the commission is never prorated to the cycle length. Founder decision, 2026-05-19. This is what keeps INV-8 true: no division, no fractional FCFA."* The counterexample bug-class is extended: "a contributor who prorates commission as `dailyAmount × cycleLength / 30` introduces a division → fractional FCFA → INV-8 violation → NFR-R3 P0."

8. **INV-5 — Cycle-day clamping — AMENDED.** **Then** the clamp range `[1, 30]` becomes `[1, cycleLength]`. `cycleDay(startDate, now)` clamps any `now` before `start_date` to 1 and any `now` after `end_date` to `cycleLength`. Skeleton name unchanged: `propCycleDayClamped` (arbitrary for the upper bound becomes `cycleLength`, not the literal 30).

9. **INV-6, INV-7, INV-8 — UNCHANGED, confirmed.** **Then** the amendment explicitly confirms each still holds with **no formulation change**: INV-6 (cycle-day monotonicity in real time), INV-7 (settlement determinism — pure function, no `Date.now()` reads), INV-8 (integer FCFA throughout). For INV-8 the amendment adds one sentence: the variable-length model introduces **no division** (commission stays a whole multiple of `dailyAmount`), so integer-FCFA outputs are preserved by construction.

10. **INV-9 — Cycle-bounds derivation — NEW.** **Then** the amendment adds a 9th invariant with the same 5-field structure as INV-1..INV-8 (statement / mathematical formulation / boundary conditions / counterexample bug-class / property-test skeleton name):
    - **Statement:** for any `start_date`, the cycle's `end_date` is the last calendar day of `month(start_date)`; if the resulting length is below `MIN_CYCLE_LENGTH_DAYS`, the cycle rolls forward to the next month (start = 1st, end = last day of next month). The derived `cycleLength` is always `≥ MIN_CYCLE_LENGTH_DAYS`.
    - **Mathematical formulation:** `endOfMonth(d) = lastDay(month(d))`; `rawLen = endOfMonth(start) − start + 1`; if `rawLen ≥ MIN_CYCLE_LENGTH_DAYS` then `(start_date, end_date) = (start, endOfMonth(start))` else `(start_date, end_date) = (firstDayOfNextMonth(start), endOfMonth(firstDayOfNextMonth(start)))`.
    - **Boundary conditions:** registration on the 1st (full month, length 28/29/30/31); registration on the last day (`rawLen = 1 < 3` → roll-forward); registration when exactly `MIN_CYCLE_LENGTH_DAYS` remain (no roll-forward — boundary is inclusive); February (28/29 days); December → January roll-forward (year boundary).
    - **Counterexample bug-class:** an off-by-one in `endOfMonth` that returns the 1st of the next month, or a roll-forward that uses `<` vs `≤` inconsistently and produces a 2-day cycle where commission ≥ contributions.
    - **Skeleton name:** `propCycleBoundsDerivation`.

11. **`MIN_CYCLE_LENGTH_DAYS` named constant.** **Then** the amendment specifies `MIN_CYCLE_LENGTH_DAYS` as a single named constant (default **3**), states it lives in `cycleEngine.ts` (Story 11.2 adds it; single point of edit, mirroring `DEFAULT_CYCLE_ENDING_WINDOW_DAYS`), and flags it as a **product-tunable pending founder sign-off** (carry it into the amendment's Open Questions, not as a blocker).

12. **Property-test skeletons sub-section.** **Then** the amendment includes an updated skeletons block for the changed invariants: `propProjectedBalanceTimeInvariance` (cycleLength arbitrary), `propSettledEqualsProjectedAtCycleEnd` (renamed), `propAdvanceCapacityBound` (cycleLength arbitrary), `propCycleDayClamped` (cycleLength upper bound), and the new `propCycleBoundsDerivation` (date arbitraries + the roll-forward assertion). Skeletons are **illustrative pseudocode** in Markdown fences — not executable. Story 11.2 implements them. Each block must show the `fast-check` arbitraries for the variable-length inputs (e.g., `cycleLength` via `fc.integer({ min: 3, max: 31 })`, or derived from generated `start_date` dates).

13. **Legacy-cycle compatibility note.** **Then** the amendment states that cycles created before Story 11.3 (rows whose `end_date` = `start_date + 29 days`) remain correct: the engine reads `end_date` from the row, so `cycleLength` for a legacy row is exactly 30 and every invariant degrades gracefully to the old behaviour. No data backfill is required. This is a property the amendment asserts so Story 11.2's tests cover a `cycleLength = 30` case explicitly.

14. **Amendment Open Questions.** **Then** the amendment carries forward exactly the open items that are genuinely undecided: (a) `MIN_CYCLE_LENGTH_DAYS` default value (recommend 3, pending founder sign-off); (b) whether a future story automates cycle restart on the 1st of the month vs. the current manual FR12 restart (out of scope for Epic 11 — note only). The original ADR's Q1/Q2 are already resolved by the shipped Epic 3 engine — do NOT re-open them.

15. **References + cross-check.** **Then** the amendment's references cite: the Sprint Change Proposal (`sprint-change-proposal-2026-05-19.md`), the amended PRD FRs (FR15-FR17, FR19, NFR-R3 — note these are edited under PRD v1.4, a separate proposal item), `epics.md` Epic 11 + Story 11.1, and `src/domain/cycle/cycleEngine.ts` (the file Story 11.2 will refactor). Every cited file path must exist today — verify with `grep`/`ls` before finalizing.

16. **Length + tone.** The amendment section targets ~120-200 lines of Markdown, matching ADR-004's existing technical, definitive register (written for the Story 11.2 dev reading it cold). No marketing prose; explicit "unchanged" calls where invariants hold; explicit "amended" calls where they change.

## Tasks / Subtasks

- [x] **Task 0 — Read the inputs (AC #3 #15).** Re-read `docs/ADR/004-cycle-invariants.md` in full, the Sprint Change Proposal `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-19.md` (especially §4.2), `src/domain/cycle/cycleEngine.ts` (the 8 functions + 2 constants the amendment describes), and `epics.md` Epic 11. Confirm the locked decisions before writing.

- [x] **Task 1 — Front-matter (AC #2).** Add the `Amended:` line to ADR-004's front-matter. Leave `Status` / `Supersedes` / `Superseded by` untouched.

- [x] **Task 2 — Append the Amendment A1 section (AC #1 #3).** After `## References`, add `## Amendment A1 — Calendar-Month Variable-Length Cycles (2026-05-19)` with an Amendment-Context sub-section (model table + worked example + Sprint-Change-Proposal pointer).

- [x] **Task 3 — Re-state INV-1…INV-8 (AC #4-#9).** Under the amendment, a sub-section per invariant: each tagged **AMENDED** (INV-1, 2, 3, 5) or **UNCHANGED** (INV-4, 6, 7, 8). Amended ones get the new formulation; unchanged ones get a one-line confirmation. INV-4 gets the explicit partial-cycle "1 full day, never prorated" note. INV-2 gets the skeleton rename.

- [x] **Task 4 — Add INV-9 (AC #10).** New invariant with all 5 fields, including the year-boundary and February boundary conditions.

- [x] **Task 5 — `MIN_CYCLE_LENGTH_DAYS` + skeletons (AC #11 #12).** Document the named constant; write the updated property-test skeleton blocks for the 4 changed invariants + INV-9.

- [x] **Task 6 — Legacy compatibility + Open Questions + References (AC #13 #14 #15).** Write the legacy-cycle note, the 2 carried-forward open questions, and the references sub-section. `grep`-verify every cited path.

- [x] **Task 7 — Self-review (AC #16).** Re-read the amendment with Story 11.2's developer hat on: every amended invariant has an unambiguous skeleton name; INV-9's roll-forward boundary (`<` vs `≤`) is stated once and unambiguously; the amendment lands in the 120-200 line target.

- [x] **Task 8 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `11-1-adr-004-variable-length-amendment: ready-for-dev` → `review`. (`epic-11` is already `in-progress` — set by create-story.)

### Review Findings

> Code review 2026-05-19 (`bmad-code-review`, 3 layers, model `claude-sonnet-4-6` ≠ implementer `claude-opus-4-7`). 8 patch findings, 12 dismissed as noise.

- [x] [Review][Patch] INV-5 signature/formula inconsistency — A1.2 prose says `cycleDay(start, end, now)` but the A1.6 skeleton calls `cycleDay(start, cycleLength, now)`; the formula uses `cycleLength` without showing it is derived from `end`. [docs/ADR/004-cycle-invariants.md A1.2/A1.6] (High, blind+edge) — RESOLVED: A1.2 formula now shows `cycleLength = end − start + 1` derivation; A1.6 INV-5 skeleton builds `endDate` from the generated length and calls `cycleDay(startDate, endDate, now)`.
- [x] [Review][Patch] INV-9 scope undefined — INV-9 is stated as a universal postcondition (`end_date` = month-end) but legacy rows (`end_date = start + 29 days`, per A1.7) violate it; INV-9 must be scoped as a write-path invariant (Story 11.3 RPCs), not a read-path assertion on existing rows. [docs/ADR/004-cycle-invariants.md A1.4/A1.7] (High, edge) — RESOLVED: added a "Scope — write-path only" bullet to INV-9 + a legacy-exemption paragraph to A1.7.
- [x] [Review][Patch] Missing `propProjectedBalanceTimeInvariance` skeleton block — AC #12 requires 5 skeleton code blocks; A1.6 has 4 (INV-2/3/5/9) and only a prose mention for INV-1. [docs/ADR/004-cycle-invariants.md A1.6] (High, auditor) — RESOLVED: added an INV-1 `it(...)` code block to A1.6.
- [x] [Review][Patch] INV-2 skeleton tests `settle` in isolation — it asserts `settle(...) === dailyAmount × contributionDays` but never calls `computeProjectedFinalBalance`, so it does not verify the `settle ≡ projected` equivalence INV-2 claims. [docs/ADR/004-cycle-invariants.md A1.6] (Med, blind) — RESOLVED: skeleton now asserts `settled === projected && settled === dailyAmount × contributionDays`.
- [x] [Review][Patch] INV-9 skeleton assertions weak — `startDate >= start` is tautological (always true by construction); `isLastDayOfMonth(endDate)` does not verify `endDate` is the last day of `startDate`'s month specifically. [docs/ADR/004-cycle-invariants.md A1.6] (Med, blind) — RESOLVED: now asserts `endDate === endOfMonth(startDate)` and `startDate === requested || startDate === firstDayOfNextMonth(requested)`.
- [x] [Review][Patch] Skeletons hardcode literal `3` — INV-2/INV-3 skeletons use `fc.integer({ min: 3, max: 31 })`, contradicting A1.5's own rule that tests MUST read `MIN_CYCLE_LENGTH_DAYS`, never the literal. [docs/ADR/004-cycle-invariants.md A1.5/A1.6] (Med, edge) — RESOLVED: all skeleton `cycleLength` arbitraries now use `{ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }`.
- [x] [Review][Patch] INV-5 skeleton type mismatch — passes a `Date` object to `cycleDay`, but the current engine's `cycleDay` takes an ISO date `string`; the original ADR skeleton did `start.toISOString().slice(0,10)`, dropped here. [docs/ADR/004-cycle-invariants.md A1.6] (Med, edge) — RESOLVED: INV-5 skeleton restores `start.toISOString().slice(0, 10)`; INV-9 skeleton passes a `requested` ISO string.
- [x] [Review][Patch] `computeMemberStats` / `daysUntilCycleEnd` generalization not noted — both hard-code `CYCLE_TOTAL_DAYS` (`daysRemaining = 30 − day`); A1.1's "Engine generalization" paragraph should note these become `cycleLength − day`. [docs/ADR/004-cycle-invariants.md A1.1] (Med, edge) — RESOLVED: A1.1 "Engine generalization" now names both helpers and their `cycleLength − cycleDay` generalization.

## Dev Notes

### Architecture compliance

- **Docs-only — no layering implications.** Story 11.2 owns the `src/domain/cycle/` refactor per architecture lines 887-892. This story changes one file under `docs/ADR/`.
- **No new dependencies.** `fast-check` is already installed (Story 3.2). The skeletons are pseudocode in Markdown fences — not executable.
- **Cite sources.** Every invariant change in the amendment points back to its origin (Sprint Change Proposal §4.2, PRD FR, `cycleEngine.ts` function).
- **ADR convention.** Mirror the existing ADR-004 register and the front-matter style of `docs/ADR/001-supabase-vault.md`.

### What changes vs. what stays — quick map for the writer

| Invariant | Status | Change |
|---|---|---|
| INV-1 projected-balance time invariance | AMENDED | `cycleDay` domain `[1,30]` → `[1,cycleLength]`; formula otherwise identical. |
| INV-2 settled ≡ projected | AMENDED | "day 30" → "cycle end"; `dailyAmount × 29` → `dailyAmount × (cycleLength−1)`; skeleton renamed. |
| INV-3 advance capacity bound | AMENDED | `× 29` → `× (cycleLength−1)`. |
| INV-4 commission invariance | **UNCHANGED** | Add partial-cycle note: 1 full day, never prorated. |
| INV-5 cycle-day clamping | AMENDED | clamp `[1,30]` → `[1,cycleLength]`. |
| INV-6 cycle-day monotonicity | **UNCHANGED** | Confirm only. |
| INV-7 settlement determinism | **UNCHANGED** | Confirm only. |
| INV-8 integer FCFA | **UNCHANGED** | Confirm + add "no division introduced" sentence. |
| INV-9 cycle-bounds derivation | **NEW** | end_date = last day of month; roll-forward `< MIN_CYCLE_LENGTH_DAYS`. |

### Current engine surface (Story 11.2 will refactor — context only, do NOT edit)

`src/domain/cycle/cycleEngine.ts` today exposes: `CYCLE_TOTAL_DAYS = 30`, `COMMISSION_DAYS = 1`, `CONTRIBUTION_DAYS = 29`, `commission()`, `computeProjectedFinalBalance()`, `canAcceptAdvance()`, `settle()`, `cycleDay()`, `isSettlementReady()`, `isCycleClosedForTransactions()`, `DEFAULT_CYCLE_ENDING_WINDOW_DAYS`, `RATTRAPAGE_DAY_OPTIONS`, `daysUntilCycleEnd()`, `computeMemberStats()`. The amendment describes the *invariants* these must satisfy after Story 11.2 — it does not prescribe the function signatures (Story 11.2 owns those, per ADR-004's existing "skeletons are illustrative" rule).

### Anti-patterns (do NOT do)

- **Do NOT edit `cycleEngine.ts` or any `src/` file.** That is Story 11.2. This story is docs-only.
- **Do NOT delete or rewrite the original INV-1…INV-8 text.** The 30-day model is the record of what Epic 3 shipped. Append an amendment; preserve history.
- **Do NOT supersede ADR-004 with a new ADR-00X.** The founder-approved proposal calls for an in-place amendment. `Superseded by:` stays `—`.
- **Do NOT re-open the original Q1/Q2 open questions** — they were resolved by the shipped Epic 3 engine.
- **Do NOT prorate the commission** or describe a prorated commission anywhere — INV-4 is unchanged by founder decision, and proration would break INV-8.
- **Do NOT write executable `.test.ts` files.** Skeletons are Markdown pseudocode; Story 11.2 implements them.
- **Do NOT install anything** — no `package.json` change.

### Definition-of-done checklist

- All 16 ACs satisfied + all 8 tasks ticked.
- `docs/ADR/004-cycle-invariants.md` keeps INV-1…INV-8 original text intact and gains a `## Amendment A1` section + an `Amended:` front-matter line.
- The amendment re-states all 8 invariants (4 amended, 4 unchanged) + adds INV-9, each with the 5-field structure where applicable.
- INV-4 carries the explicit "1 full day, never prorated" partial-cycle note.
- Updated property-test skeletons present for the 4 changed invariants + INV-9; `propSettledEqualsProjectedAtDay30` renamed to `propSettledEqualsProjectedAtCycleEnd`.
- `MIN_CYCLE_LENGTH_DAYS` documented (default 3, flagged tunable).
- Legacy-cycle compatibility note present.
- References cross-check: every cited path exists (verified via `grep`/`ls`).
- Amendment section lands in the 120-200 line range.
- Story status → `review`; `sprint-status.yaml` updated.
- Zero `src/` changes, zero migrations, zero new dependencies.

## Dev Notes — Project Structure Notes

- Output file: `docs/ADR/004-cycle-invariants.md` (edit existing). No new file created.
- `sprint-status.yaml`: only the `11-1-…` story key flips `ready-for-dev` → `review`. `epic-11` is already `in-progress`.
- No conflict with the unified project structure — ADRs live under `docs/ADR/`, established by ADR-001…ADR-004.

## References

- **Sprint Change Proposal (canonical decision record):** `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-19.md` — § "Canonical new model", §4.2 (ADR-004 amendment spec), §3 (Epic 11 story cluster).
- **ADR to amend:** `docs/ADR/004-cycle-invariants.md` — 8 invariants (INV-1…INV-8), property-test skeletons, open questions Q1/Q2.
- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` — Epic 11 (Calendar-Month Cycle Model) + Story 11.1 BDD.
- **Precedent story:** `_bmad-output/implementation-artifacts/3-1-cycle-invariants-adr.md` — the original docs-only ADR-004 story; mirror its scope discipline and structure.
- **Engine (Story 11.2 will refactor — context only):** `src/domain/cycle/cycleEngine.ts` — `CYCLE_TOTAL_DAYS`, `CONTRIBUTION_DAYS`, the 8 cycle functions.
- **PRD (amended under v1.4 — separate proposal item):** `_bmad-output/planning-artifacts/prd.md` — FR15, FR16, FR17, FR19 (lines 495-499), NFR-R3 (line 565).
- **ADR template / front-matter convention:** `docs/ADR/001-supabase-vault.md`.
- **Layering + operating rules:** `CLAUDE.md` § Operating principles.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context) — `bmad-dev-story` workflow, 2026-05-19.

### Debug Log References

(none — docs-only story; no test runs, no CI iterations. `npx prettier --check` flagged formatting on first write; `prettier --write` applied; re-check clean.)

### Completion Notes List

- All 16 ACs satisfied. `docs/ADR/004-cycle-invariants.md` amended in place — original Sections (the 30-day model) preserved verbatim; new `## Amendment A1 — Calendar-Month Variable-Length Cycles (2026-05-19)` section appended after `## References`.
- Front-matter gained an `Amended:` line; `Status` / `Supersedes` / `Superseded by` untouched (amended, not superseded — per the founder-approved proposal).
- Amendment re-states all 8 invariants: INV-1/2/3/5 **AMENDED** (re-parameterized `30`/`29`/`[1,30]` → `cycleLength`/`contributionDays`/`[1,cycleLength]`); INV-4/6/7/8 **UNCHANGED** and re-confirmed. INV-4 carries the explicit founder-decision note: partial cycles take 1 full commission day, never prorated — the property that keeps INV-8 (integer FCFA) true with no division.
- INV-2 skeleton renamed `propSettledEqualsProjectedAtDay30` → `propSettledEqualsProjectedAtCycleEnd` (Story 11.2 must rename the test).
- New **INV-9** (cycle-bounds derivation) added with the full 5-field structure: `end_date` = last day of `month(start_date)`; roll-forward when residual `< MIN_CYCLE_LENGTH_DAYS`; year-boundary + February boundary conditions called out.
- `MIN_CYCLE_LENGTH_DAYS` documented (default 3, flagged product-tunable in Open Questions A1-Q1).
- 4 updated + 1 new `fast-check` property-test skeletons included as illustrative pseudocode.
- Legacy-cycle compatibility note (A1.7): pre-Story-11.3 rows yield `cycleLength = 30` and degrade to the original behaviour — no backfill; Story 11.2 must add a `cycleLength = 30` test case.
- Amendment section lands at 186 lines (target 120-200). References cross-checked: every cited path verified to exist (`ls`/`sed`), PRD FR lines 495-499 + NFR-R3 line 565 confirmed.
- `npx prettier --check docs/ADR/004-cycle-invariants.md` → clean.
- Zero `src/` changes, zero migrations, zero new dependencies — strict docs-only as the spec demanded.

### File List

**Modified (2 files):**
- `docs/ADR/004-cycle-invariants.md` — front-matter `Amended:` line + `## Amendment A1` section.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `11-1-…` status flips + touched line.

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-05-19 | Winston (architect) | Story 11.1 spec generated by `bmad-create-story`. FIRST story of Epic 11 (Calendar-Month Cycle Model) — `epic-11` flipped `backlog` → `in-progress`. Docs-only: amends `docs/ADR/004-cycle-invariants.md` in place with an `## Amendment A1` section — re-parameterizes INV-1/2/3/5 for variable cycle length, confirms INV-4/6/7/8 unchanged (INV-4 gains an explicit "1 full day, never prorated" partial-cycle note), adds INV-9 (cycle-bounds derivation + roll-forward). Gates Stories 11.2-11.4. Source: founder-approved Sprint Change Proposal 2026-05-19. Status → ready-for-dev. |
| 2026-05-19 | dev agent | Implementation complete via `bmad-dev-story`. ADR-004 amended in place: `Amended:` front-matter line + `## Amendment A1` section (186 lines) — INV-1/2/3/5 re-parameterized, INV-4/6/7/8 confirmed unchanged, INV-9 added, INV-2 skeleton renamed to `propSettledEqualsProjectedAtCycleEnd`, `MIN_CYCLE_LENGTH_DAYS` (default 3) documented, 5 property-test skeletons, legacy-cycle compatibility note. All 16 ACs satisfied, all 8 tasks complete. Prettier clean, references cross-checked. Zero code/migration/dependency change. Status → review. |
| 2026-05-19 | code review | `bmad-code-review` — 3 adversarial layers (model `claude-sonnet-4-6` ≠ implementer). 8 patch findings, all resolved; 12 dismissed as noise. Fixes to `docs/ADR/004-cycle-invariants.md`: INV-5 signature/formula made consistent (`cycleDay(start, end, now)` + derivation shown); INV-9 scoped as a write-path invariant + legacy-exemption note in A1.7; INV-1 skeleton code block added (AC #12); INV-2 skeleton now asserts the `settle ≡ projected` equivalence; INV-9 skeleton assertions strengthened (`endDate === endOfMonth(startDate)`, non-tautological `startDate` check); skeleton `cycleLength` arbitraries use `MIN_CYCLE_LENGTH_DAYS` not literal 3; INV-5 skeleton restores ISO-string conversion; A1.1 notes `daysUntilCycleEnd` / `computeMemberStats` generalization. Prettier clean. Status → done. |
