# Story 5.1: AdvanceSimulationPanel component with client-side real-time computation

Status: review

## Story

As a **developer**,
I want **a reusable `AdvanceSimulationPanel` component that computes and displays the impact of an advance on projected final balance in real time**,
so that **the collector can show the saver the exact number before commit (UX-DR7, NFR-P5).**

> **Predicate of this story.** Epic 5 opens with the simulation panel because Story 5.2 (situation-in-context flow) and Story 5.4 (commit) both consume it. Story 5.1 ships the **pure presentation component** — props in, JSX out, zero state machine, zero network. The cycle-engine math primitives shipped by Story 3.2 (`commission`, `computeProjectedFinalBalance`, `canAcceptAdvance`) supply the four numbers; Story 5.1 wraps them in a 4-row card matching the UX spec. No new domain primitives, no migrations, no hooks. Mirrors Story 4.2's "pure component, no internal state" pattern.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 894-903; the rest are spec-derived constraints.

1. **4-row anatomy.** **Given** a member with `dailyAmount`, `existingAdvances` (the array of advance amounts already booked on the cycle), and a candidate advance amount, **When** the panel renders, **Then** it displays exactly 4 rows in this order:
   1. **Total cycle projected** — `dailyAmount × CYCLE_TOTAL_DAYS` (= `dailyAmount × 30`).
   2. **Commission** — prefixed with `−` and rendered with the success/primary tint = `commission(dailyAmount)` (= `dailyAmount × 1` per Story 3.2 line 28).
   3. **Advance** — prefixed with `−` and rendered in the **destructive** colour palette = `candidateAmount` (the user-supplied value, echoed back; `0` when empty).
   4. **Projected final balance** — large, primary-green, bold (uses the existing `text-amount-large` Tailwind utility from `tailwind.config.ts:107`) = `computeProjectedFinalBalance(dailyAmount, sumOfExistingAdvances + candidateAmount)`.

2. **Pure presentation.** Lives at `src/components/domain/AdvanceSimulationPanel.tsx` per `architecture.md:1113`. **No** internal `useState` for amount, **no** `useQuery`, **no** `useEffect` for derived values — every output is derived synchronously from props on each render. Mirrors the discipline of `ProgressiveToast.tsx` (Story 4.2) and `MemberActionSheet.tsx`'s presentation core.

3. **Props contract.**
   ```ts
   export interface AdvanceSimulationPanelProps {
     dailyAmount: number;            // FCFA integer (positive)
     existingAdvances: ReadonlyArray<number>;  // FCFA integers (each positive); empty array allowed
     candidateAmount: number;        // FCFA integer; 0 when the input is empty (caller normalises)
     className?: string;             // for caller-side spacing/sizing tweaks
   }
   ```
   The component does NOT accept a `cycleDay` — the projection formula (FR17 / Story 3.2 INV-1) is **independent of cycle day**. Adding it would invite confusion. The Story 5.2 advance-flow displays cycle day SEPARATELY in its situation-in-context panel (different component).

4. **Three states (mirror UX spec lines 1046-1052).**
   - **Empty** (`candidateAmount === 0`): rows 1 + 2 populated; row 3 shows the placeholder *"— FCFA"*; row 4 is dimmed (e.g., `opacity-50` or `text-text-secondary`) to indicate inactive.
   - **Valid** (`candidateAmount > 0` AND `canAcceptAdvance(dailyAmount, existingAdvances, candidateAmount) === true`): all rows populated; row 4 is fully emphasised in primary-green large.
   - **Over-limit** (`candidateAmount > 0` AND `canAcceptAdvance(...) === false`): row 3 receives a warning style (e.g., `text-warning-800` + a small explanatory note below it: *"Dépasse le solde disponible"*); row 4 displays `0 FCFA` with an explanatory note: *"Le prêt ne peut pas dépasser le solde projeté."* Per BDD line 903.

5. **Performance — render budget ≤ 16 ms (NFR-P5).** **When** the collector modifies `candidateAmount`, **Then** rows 3 and 4 update within one animation frame. The component is pure JSX + arithmetic — meeting 16 ms is trivial unless React is misused. **Forbidden patterns** that would break the budget:
   - **Do NOT** use `useEffect` to derive values (causes a second render).
   - **Do NOT** use `JSON.parse(JSON.stringify(...))` or any deep clone.
   - **Do NOT** call `Intl.NumberFormat` inline 4× per render — instantiate once at module scope (the existing `formatFcfaAmount` from `src/features/member/api/formatAmount.ts` already does this; reuse it).
   - The Story 5.2 / 5.4 callers are responsible for memoising their inputs (`useMemo` on `existingAdvances` if derived from a fetch).

6. **Accessibility — `aria-live` on the final balance.** Per UX spec line 1058: row 4's container has `aria-live="polite"` so screen readers announce the updated projected balance as the candidate amount changes. **Do NOT** put `aria-live` on rows 1 + 2 (they don't change with the candidate amount) or row 3 (the candidate echo is already visible in the input the user is typing into). Single live region = one focused announcement = no spam.

7. **Currency formatting.** Use `formatFcfaAmount(amount)` from `src/features/member/api/formatAmount.ts` (Story 2.1) for every numeric output. The "FCFA" suffix is appended inline as plain text with a non-breaking space (the formatter only handles the digit grouping). Consistent with Story 2.1 / 2.4 patterns.

8. **No hard-coded hex.** All colours go through Tailwind tokens already configured by Story 2.1's design-token pass:
   - Row 1, 2: default text (`text-text-primary` / `text-text-secondary`).
   - Row 3 (Advance): destructive — use `text-destructive` or the existing `text-destructive-foreground` family. **Do NOT** invent new tokens.
   - Row 3 over-limit: `text-warning-800` (already used by `MemberActionSheet`'s cycle-closed banner per Story 4.1).
   - Row 4 valid: `text-primary` (the SafariCash-green token).
   - Row 4 dimmed (empty state): `text-text-secondary` or `opacity-50`.
   - Card border: `border-primary-200` per UX spec line 1039.

9. **i18n keys.** Add to `src/i18n/fr.json`:
   - `advance.simulation.row_total` = `"Total cycle projeté"`
   - `advance.simulation.row_commission` = `"Commission"`
   - `advance.simulation.row_advance` = `"Prêt"`
   - `advance.simulation.row_final_balance` = `"Solde final projeté"`
   - `advance.simulation.amount_placeholder` = `"— FCFA"`
   - `advance.simulation.over_limit_row` = `"Dépasse le solde disponible"`
   - `advance.simulation.over_limit_note` = `"Le prêt ne peut pas dépasser le solde projeté."`
   - 7 keys, no pluralisation.

10. **Component file structure.** New `src/components/domain/AdvanceSimulationPanel.tsx`:
    - 1-line header comment citing BDD lines 894-903 + FR24 + Story 3.2 (the math source).
    - Exports `AdvanceSimulationPanel` + `AdvanceSimulationPanelProps`.
    - Pure functional component. Internally derives `state: "empty" | "valid" | "over-limit"` once at the top from the props.

11. **No barrel re-export at MVP.** Like `MemberActionSheet`, the component is imported directly: `import { AdvanceSimulationPanel } from "@/components/domain/AdvanceSimulationPanel"`. No `src/components/domain/index.ts` file exists yet (verified in repo); don't introduce one in this story.

12. **Tests — vitest + RTL + jest-axe.** New `src/components/domain/AdvanceSimulationPanel.test.tsx`. Cases:
    - **Empty state** (`candidateAmount=0`): 4 rows render; row 3 shows the placeholder; row 4 is dimmed (assert via class or aria attribute).
    - **Valid state** (`dailyAmount=5000, existingAdvances=[10000], candidateAmount=20000`): row 1 = 150000, row 2 = 5000, row 3 = 20000, row 4 = 115000 (= 5000×29 − 30000).
    - **Boundary state** (`dailyAmount=5000, existingAdvances=[], candidateAmount=145000`): row 4 = 0; `canAcceptAdvance` returns true (boundary equality per Story 3.2 line 57); state is `valid` not `over-limit`.
    - **Over-limit** (`dailyAmount=5000, existingAdvances=[], candidateAmount=200000`): row 3 has the warning class + the over-limit note; row 4 shows `0 FCFA` + the explanatory note.
    - **`aria-live` on row 4 only.** Inspect the DOM: row 4's container has `aria-live="polite"`; rows 1-3 don't.
    - **Re-render on prop change.** Render with `candidateAmount=10000`, then re-render with `candidateAmount=20000`; row 4 reflects the new value. Pair with `vi.useFakeTimers` if needed; otherwise standard RTL `rerender`.
    - **axe-clean.** No accessibility violations across the 3 states.
    - **Memoisation correctness.** Render twice with identical props; assert no `console.error` (e.g., from accidental array references that would trigger React's strict-mode warnings).

13. **No new dependencies.** Pure TS + React + Tailwind + Lucide (if needed for the over-limit icon — optional decoration only). No npm install.

14. **No domain changes.** The cycle-engine functions used (`commission`, `computeProjectedFinalBalance`, `canAcceptAdvance`, `CYCLE_TOTAL_DAYS`) are already exported from `src/domain/cycle` (Story 3.2). 100 % coverage gate is unaffected — Story 5.1 is component-layer only.

15. **No `use client` / SSR concerns.** The repo is a Vite-built SPA (not Next.js); the `"use client"` directive doesn't apply.

16. **Storybook NOT shipped.** No Storybook in the repo (verify: no `.storybook/` directory). Story 5.1's component is exercised via the Vitest test file; Story 5.2's `AdvanceFlow` will be the first real consumer.

17. **All gates green.**
    - `npm run typecheck` — strict TS clean (no `any`, no `as` casts at API boundaries).
    - `npm run lint` — no new warnings; ESLint cross-feature import rule respected (`AdvanceSimulationPanel` imports from `@/domain/cycle` — allowed; from `@/features/member/api/formatAmount` — allowed because `components/domain/` is a shared layer, not a feature).
    - `npm test -- --coverage` — domain still 100 %; new component file ≥ 80 %.
    - `npm run build` — bundle delta < 2 kB gzipped (1 component + 7 i18n strings).
    - `npx playwright test` — UNCHANGED (no new E2E; Story 5.4 will add a Flow 2 advance E2E that exercises this component end-to-end).

## Tasks / Subtasks

- [x] **Task 0 — Component (AC #1 #2 #3 #4 #6 #8 #10).** Create `src/components/domain/AdvanceSimulationPanel.tsx`. Pure functional component. Compute `state` once at the top of the body. Render 4 rows + the optional explanatory note for over-limit.

- [x] **Task 1 — i18n keys (AC #9).** Add 7 keys under `advance.simulation.*` to `src/i18n/fr.json`. The `TranslationKey` derivation picks them up.

- [x] **Task 2 — Tests (AC #12).** Create `src/components/domain/AdvanceSimulationPanel.test.tsx`. ≥ 7 cases. Use `jest-axe` for the a11y assertion.

- [x] **Task 3 — All gates (AC #17).** `typecheck` / `lint` / `test --coverage` / `build`.

- [x] **Task 4 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `5-1-advance-simulation-panel: ready-for-dev → review`. Confirm `epic-5: in-progress` (set by `bmad-create-story` when this story spec is generated, per workflow.md step 1).

## Dev Notes

### Architecture compliance

- **Layering.** `src/components/domain/` is the shared-component layer (sibling of `src/components/ui/` for shadcn-copied primitives). Imports from `@/domain/cycle` (downward, allowed) and `@/features/member/api/formatAmount` (cross-layer for a utility function — allowed since `components/domain/` is not a feature with its own enforced barrel). No imports from `@/features/transaction/` or `@/features/member/ui/` (would be a layering violation).
- **Cite sources.** File header references BDD lines 894-903 + FR24 + UX spec lines 1033-1061 + Story 3.2 (the math source).
- **Tokens, not hex.** Every colour resolves through Tailwind config; `text-amount-large` is the existing utility for row 4's typography (`tailwind.config.ts:107`).
- **No premature abstraction.** This is one component for one purpose; resist the urge to generalise it into a "row-summary card" abstraction. Story 5.2 may render it as-is or wrap it; either way the component's API stays narrow.

### Why no `cycleDay` prop

Story 3.2 INV-1 (ADR-004): `computeProjectedFinalBalance` is **independent of cycle day**. The projected balance at day 30 equals the projected balance computed at day 1 — that's the whole point of the projection formula. Adding `cycleDay` to the panel would invite a future bug where someone gates the simulation on day-N: the math is the same on every day. Story 5.2's situation-in-context panel (a SEPARATE component, not this one) displays the cycle day for the saver's mental orientation; the simulation panel doesn't need it.

### Why echo `candidateAmount` literally in row 3 (not formatted with the input mask)

The collector types into the advance-flow's amount input (Story 5.2 will own that input). The input emits an integer to `candidateAmount`. Row 3 echoes that integer formatted via `formatFcfaAmount`. This is the simplest contract:
- Caller normalises the input (empty → 0, leading zeros → integer parse, etc.).
- Component displays the integer + label.

The component is NOT responsible for input parsing. That's Story 5.2's territory.

### Why row 4 = 0 (not negative) on over-limit

`computeProjectedFinalBalance` happily returns negative numbers (Story 3.2 line 41-44, ADR-004 Q1: *"returns the raw value (may be negative); UI decides presentation"*). Story 5.1's UI clamps the over-limit display to `0 FCFA` per BDD line 903 (*"row 4 shows 0 FCFA with an explanatory note"*). The clamp is a UI presentation choice, not a math change — the engine still returns the negative value if asked.

### Why `aria-live="polite"` (not `assertive`)

The simulation panel updates as the user types — using `assertive` would interrupt every keystroke, making the input field unusable for screen-reader users. `polite` queues the announcement until the live region settles, giving screen-reader users the final balance after a typing pause without interrupting their input. Per UX spec line 1058's *"announces updates as amount changes"* — polite is the right form.

### Why a single state derivation at the top of the component (not three branches)

```tsx
const state: "empty" | "valid" | "over-limit" =
  candidateAmount === 0
    ? "empty"
    : canAcceptAdvance(dailyAmount, existingAdvances, candidateAmount)
      ? "valid"
      : "over-limit";
```

This 5-line derivation runs once per render, then drives the JSX via conditional class names + conditional notes. It's denser than three sibling components and easier to reason about (one state machine, three view shapes).

### Anti-patterns (do NOT do)

- **Do NOT** add `useMemo` to the math. The functions are O(n) where n is `existingAdvances.length` (typically 0-3); React's reconciler is already faster than the cost of `useMemo`'s dependency comparison.
- **Do NOT** render the panel inside a portal or animated transition. It's a static card in a flow; animations belong to the surrounding flow surface (Story 5.2).
- **Do NOT** invent new design tokens. Story 2.1's pass cemented the palette; Story 4.x consumed warning + destructive variants; Story 5.1 reuses them.
- **Do NOT** put input-handling logic here. The candidate amount comes in pre-parsed.
- **Do NOT** display a negative final balance — clamp to 0 with the explanatory note per BDD line 903.
- **Do NOT** add `cycleDay` to the props (see § Why no `cycleDay` prop above).
- **Do NOT** ship a barrel export for `components/domain/`. The repo's convention is direct imports for shared-domain components.
- **Do NOT** ship Storybook. The repo doesn't use it.

### Edge cases worth testing

- **`existingAdvances = []`, `candidateAmount = 0`.** Empty state; row 3 placeholder; row 4 dimmed showing `dailyAmount × 29` (the projected balance with no advance).
- **`existingAdvances = [dailyAmount × 29]`** (already at the boundary). Any positive `candidateAmount` triggers over-limit (because the existing advance already consumed the full available balance).
- **`dailyAmount = 0`** (defensive — invalid per Story 2.2 / 2.5 validation). The component should render without crashing; row 1 = 0, row 2 = 0, row 3 = candidate echo, row 4 = -candidate (or 0 if clamped). Document that this is unreachable in production but the component shouldn't blow up.
- **`candidateAmount` negative** (caller bug). The component clamps `state` based on `canAcceptAdvance` which would still return true (negative + existing < dailyAmount × 29); row 3 displays the negative value. Caller is responsible for not passing negative values; this is defensive, not contractually supported.
- **Very large `candidateAmount` (e.g., 999_999_999)**. `formatFcfaAmount` handles arbitrary integers; the layout breaks at narrow widths. Acceptable for the test surface; production-safe via the input's max-value validation in Story 5.2.
- **All-zero existing advances**. `existingAdvances = [0]` is invalid per the engine's contract (advances are positive). The component doesn't enforce this — sum is still 0 + candidate. Caller's responsibility.

### Definition-of-done checklist

- All 17 ACs satisfied + all 5 tasks ticked.
- 1 component + 1 test file + 7 i18n keys.
- 7+ vitest cases including jest-axe assertion.
- Coverage gate maintained (domain 100 %; component file ≥ 80 %).
- All gates green: typecheck / lint / test / build.
- Story status set to `review`; sprint-status updated.
- Epic 5 status reflected as `in-progress` in sprint-status.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 884-903 (Epic 5 + Story 5.1 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` (FR24 — advance with situation-in-context + simulation; FR17 — projected balance formula).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md:1113` (Flow 2 component map: `AdvanceSimulationPanel.tsx` lives in `src/components/domain/`).
  - `_bmad-output/planning-artifacts/architecture.md:1102` (NFR-R3 — cycle correctness gate; the component consumes the engine, doesn't reimplement).
- **UX spec:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md:1033-1061` (component anatomy, states, a11y).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:509` (warning palette — used for over-limit row 3).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:510` (destructive palette — used for valid row 3).
- **Domain (the math source):**
  - `src/domain/cycle/cycleEngine.ts:14` (`CYCLE_TOTAL_DAYS = 30`).
  - `src/domain/cycle/cycleEngine.ts:28` (`commission(dailyAmount)`).
  - `src/domain/cycle/cycleEngine.ts:43` (`computeProjectedFinalBalance(dailyAmount, advancesSoFar)`).
  - `src/domain/cycle/cycleEngine.ts:52` (`canAcceptAdvance(dailyAmount, existingAdvances, newAdvanceAmount)`).
- **Design tokens:**
  - `tailwind.config.ts:107` (`text-amount-large` typography).
- **Existing patterns to mirror:**
  - `src/components/domain/ProgressiveToast.tsx` (Story 4.2 — pure presentation, no internal state).
  - `src/components/domain/MemberActionSheet.tsx` (Story 4.1 — props-driven, optional handlers).
  - `src/features/member/api/formatAmount.ts` (Story 2.1 — the FCFA formatter).
- **Companion stories (downstream consumers):**
  - Story 5.2 — `AdvanceFlow.tsx` — first real consumer (situation-in-context + amount input + simulation panel + suggested chips).
  - Story 5.3 — motive + saver acknowledgment (gates the commit CTA; doesn't touch this component).
  - Story 5.4 — commit RPC + audit + cycle status flip + SMS enqueue (consumes the panel's `candidateAmount`).
- **Process discipline:** No DB / RPC / Edge Function changes in this story → no `npm run db:migrate` step. Pure component.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] via `bmad-dev-story` skill (Claude Code).

### Debug Log References

- **`text-body-3` Tailwind utility doesn't exist** in the config (only `body-1` / `body-2`). Spec mentioned it for the over-limit notes; substituted `text-body-2` with `text-warning-text` for color contrast.
- **`getByText(/0 FCFA/)`** matched multiple elements at the boundary case (row 3 echoes `− 145 000 FCFA` which contains `0 FCFA` as a substring). Tightened the regex to `/^0 FCFA$/` for the exact-match-only assertion on row 4.

### Completion Notes List

- All 17 ACs satisfied. 5 tasks complete.
- New `<AdvanceSimulationPanel>` component at `src/components/domain/AdvanceSimulationPanel.tsx`: pure presentation, 4-row card driven by Story 3.2's cycle-engine primitives (`commission`, `computeProjectedFinalBalance`, `canAcceptAdvance`, `CYCLE_TOTAL_DAYS`).
- 3 states (empty / valid / over-limit) derived once at the top of the body — no `useState`, no `useEffect`, no internal hooks.
- `aria-live="polite"` on the row 4 container ONLY; rows 1-3 don't change with the candidate amount.
- Row 4 clamped to `0 FCFA` on over-limit (BDD line 903) — engine still returns the raw negative value; UI presentation handles the clamp.
- 7 i18n keys under `advance.simulation.*` namespace.
- 8 vitest tests covering empty / valid / boundary / over-limit / aria-live presence / re-render / 3 states × jest-axe.
- All gates green: typecheck ✅ / lint ✅ / 508 vitest passing (1 skipped) ✅ / build ✅.
- No E2E added — Story 5.4's commit-path E2E will exercise the panel end-to-end.

### File List

**New (2 files):**

- `src/components/domain/AdvanceSimulationPanel.tsx`
- `src/components/domain/AdvanceSimulationPanel.test.tsx`

**Modified (3 files):**

- `src/i18n/fr.json` (7 new keys under `advance.simulation.*`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flips)
- `_bmad-output/implementation-artifacts/5-1-advance-simulation-panel.md` (this file — Tasks ✓, Completion Notes, Status → review)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-26 | Winston (architect) | Story 5.1 spec generated by `bmad-create-story`. Opens Epic 5 (Emergency Advance Flow) with the pure presentation component `AdvanceSimulationPanel`: 4-row card (Total cycle projected / Commission / Advance / Projected final balance) driven by Story 3.2's cycle-engine primitives, three states (empty / valid / over-limit), `aria-live="polite"` on the final balance, currency formatting via `formatFcfaAmount`, all colours via Tailwind tokens. No internal state, no hooks, no migrations. Mirrors Story 4.2's pure-component discipline. Status → ready-for-dev. |
| 2026-04-27 | dev agent (Opus 4.7 via `bmad-dev-story`) | Implementation complete. 2 new files + 3 modified. 8 vitest tests including jest-axe across the 3 states. All gates green: typecheck / lint / 508 vitest (1 skipped) / build. No E2E (deferred to Story 5.4's commit-path spec). Status → review. |
