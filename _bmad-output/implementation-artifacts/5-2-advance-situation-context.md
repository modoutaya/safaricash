# Story 5.2: Advance flow with situation-in-context panel

Status: ready-for-dev

## Story

As a **collector**,
I want **a dedicated advance flow that first shows the member's current situation (day, contributed, existing advances) before I enter an amount**,
so that **I grant advances with full context (FR24).**

> **Predicate of this story.** Story 5.1 shipped `<AdvanceSimulationPanel>`. Story 5.2 ships the **screen** that hosts it: a new `/members/:id/advance` route + an `<AdvanceFlow>` component with (a) a situation panel at the top (cycle day, contributed-so-far, existing-advances), (b) 3 suggested-amount chips (50k / 100k / 150k FCFA), (c) a free-form amount input, (d) the simulation panel from 5.1. The flow surface is COMPLETE for read-only / preview semantics; the **commit** path lands in Story 5.4. Story 5.3 will gate the primary CTA on motive + saver acknowledgment. Story 5.2 renders a primary CTA in a **disabled** state with a placeholder tooltip — mirrors Story 4.1's "ship the shell, downstream stories wire the handler" discipline.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 911-918; the rest are spec-derived constraints.

1. **New route.** Edit `src/app/router.tsx` to add `{ path: "members/:id/advance", element: <AdvanceFlowRoute /> }` AFTER the existing `members/:id/edit` route (matching the longer-static-segment ordering rule documented in router.tsx lines 51-54). The route is wrapped by `<ProtectedRoute>` + `<AppLayout>` like its siblings. New route file `src/app/routes/members/[id].advance.tsx` mirrors the Story 2.5 `[id].edit.tsx` pattern: reads `:id` via `useParams`, delegates rendering to `<AdvanceFlow memberId={id} />`.

2. **`<AdvanceFlow>` component lives at `src/features/transaction/ui/AdvanceFlow.tsx`** per `architecture.md:1113`. Props:
   ```ts
   export interface AdvanceFlowProps {
     memberId: string;
   }
   ```
   The component is a screen-level surface — it owns its layout, fetches its own data via `useMemberProfile(memberId)` (Story 2.4), and drives its local UI state (candidate amount). It does NOT accept the candidate amount as a prop; the input is internal to this component for now (Story 5.4 may lift state to a parent if needed for commit integration).

3. **Entry point — wire `onAdvance` in `MemberList`.** Edit `src/features/member/ui/MemberList.tsx`. The `<MemberActionSheet>` already accepts an optional `onAdvance` prop (Story 4.1 line 44). Wire:
   ```tsx
   onAdvance={(memberId) => {
     setActiveMemberId(null);
     navigate(`/members/${memberId}/advance`);
   }}
   ```
   Spread the prop conditionally on `activeMember.currentCycle` being non-null AND not closed (mirror Story 4.3's `onRecordContribution` pattern). When closed/null → secondary "Prêt" link stays disabled (Story 4.1's existing `closed` gate handles this).

4. **Situation panel at the top.** **Given** the advance flow is open for a member with active cycle, **When** the panel renders, **Then** it displays exactly 3 facts in a horizontal info card:
   - **Cycle day:** `t("advance.flow.situation.cycle_day", { day: stats.cycleDay })` → *"Jour {day} sur 30"*.
   - **Contributed so far:** `t("advance.flow.situation.contributed", { amount: formatFcfaAmount(stats.contributedTotal) })` → *"Versé : {amount} FCFA"*.
   - **Existing advances:** `t("advance.flow.situation.advances", { amount: formatFcfaAmount(stats.outstandingAdvances) })` → *"Avances en cours : {amount} FCFA"*.
   - All 3 values come from `useMemberProfile`'s `stats: MemberStats` (Story 2.4 / Story 3.2 `computeMemberStats`).
   - Card style: subtle informational tint per UX spec line 511 (Informational / Neutral palette: `bg-info-50 text-info-900 border-info-200` if those tokens exist; otherwise the closest existing semantic class names).

5. **Suggested-amount chips.** Render 3 chips horizontally below the situation panel:
   - Values: `[50_000, 100_000, 150_000]` (FCFA), locked behind a constant `ADVANCE_SUGGESTED_AMOUNTS = [50_000, 100_000, 150_000] as const` exported from `src/features/transaction/api/advanceConstants.ts`. **DO NOT** put these in `domain/cycle/` — they're a UX decision, not a domain invariant.
   - Each chip: pill button with the formatted amount (`formatFcfaAmount(n) + " FCFA"`).
   - Tap → sets the candidate amount input to `n`.
   - Active state (when `candidateAmount === n`): primary-green tint + `aria-pressed="true"`.
   - Disabled state: chip greys out + `disabled` attr when `n` would over-limit (`!canAcceptAdvance(dailyAmount, existingAdvances, n)`). The collector can still type a custom amount in the input.
   - 44×44 px minimum touch targets (NFR-A2 — already satisfied by the `<Button>` ghost variant).

6. **Free-form amount input.** Below the chips:
   - `<input type="number" inputMode="numeric" />` (NOT `type="text"` — keyboard hint matters on mobile).
   - Min `0`, step `100` (FCFA — no sub-unit), max `dailyAmount × CONTRIBUTION_DAYS - sum(existingAdvances)` (i.e., the maximum advance the engine accepts; computed from `canAcceptAdvance`'s implicit boundary).
   - Empty input → `candidateAmount = 0` (the simulation panel renders the empty state).
   - Non-empty + valid → updates `candidateAmount`.
   - Non-empty + invalid (e.g., negative, non-integer) → caller-side Zod validation; if invalid, `candidateAmount = 0` (treat as empty for display purposes; **don't** raise a form error in Story 5.2 — Story 5.4 will surface validation errors at commit time).
   - Label above the input: `t("advance.flow.amount_input.label")` → *"Montant du prêt (FCFA)"*.
   - Helper text below: `t("advance.flow.amount_input.helper")` → *"Ou choisissez un montant suggéré ci-dessus."*.
   - **Implementation:** local `useState<string>` for the raw input string; derived `candidateAmount = useMemo(() => parseInt(rawInput, 10) || 0, [rawInput])`. Use a string state (not number) so partial typing like "50" doesn't get coerced to `50` immediately when the user is typing "500".

7. **`<AdvanceSimulationPanel>` consumed.** Below the input, render:
   ```tsx
   <AdvanceSimulationPanel
     dailyAmount={member.dailyAmount}
     existingAdvances={existingAdvanceAmounts}
     candidateAmount={candidateAmount}
   />
   ```
   - `existingAdvanceAmounts` is derived from `data.transactions.filter((t) => t.kind === "advance").map((t) => t.amount)`. Memoised via `useMemo` to keep the simulation panel's input reference stable across re-renders (per Story 5.1 § Performance note about caller-side memoisation).
   - The simulation panel updates synchronously as the user types — Story 5.1's pure component handles the ≤ 16 ms budget.

8. **Primary CTA "Accorder" — DISABLED at Story 5.2.** Renders with `disabled` + a `title` tooltip *"Disponible bientôt"* (reuse the existing `members.profile.action_disabled_tooltip` i18n key from Story 2.4). The CTA is rendered SO the layout is final and Story 5.3 + 5.4 only need to wire the gate logic + handler. Mirror Story 4.1's MemberActionSheet pattern: render the button structure, defer the handler to a downstream story.

9. **Back navigation.** Top of the screen: a `<Link to={\`/members/${memberId}\`}>` with `aria-label={t("advance.flow.back_label")}` (*"Retour au profil"*). Standard back chevron + label pattern matching `MemberProfile` / `MemberEdit`.

10. **Closed-cycle gate.** **Given** the member's current cycle is `completed` or `settled` (per Story 3.4's `isCycleClosedForTransactions`), **When** the advance flow loads, **Then** it redirects (`<Navigate to={\`/members/${memberId}\`} replace />`) back to the member profile WITHOUT rendering the flow. Rationale: an advance on a closed cycle would be rejected at commit time anyway (Story 3.4 BEFORE INSERT trigger raises 23514); the UX should never lead the collector to a flow that can't commit. The MemberActionSheet's closed-cycle guard from AC #3 already prevents this entry path; the redirect is defence-in-depth for a direct URL hit.

11. **No active cycle gate.** **Given** the member has `currentCycle === null` (rare — would indicate Story 2.2's invariant breach OR a member in `paused`/`completed` member-status), **When** the advance flow loads, **Then** it redirects back to the member profile. Same defence-in-depth as AC #10.

12. **Loading + error states.**
    - `useMemberProfile.isLoading` → render `null` (no skeleton — same MVP convention as `MemberList`).
    - `useMemberProfile.isError` → `<MemberProfileStates>`-style error fallback (reuse the existing component from Story 2.4's `src/components/domain/MemberProfileStates.tsx` if it has an error variant; otherwise inline a copy with `t("advance.flow.error.load")` + a "Retour" button to `/members/:id`).
    - `useMemberProfile.data === undefined` (member not found) → redirect to `/members` with a toast (mirror Story 2.4's not-found behaviour).

13. **i18n keys.** Add to `src/i18n/fr.json` under `advance.flow.*`:
    - `advance.flow.title` = `"Accorder un prêt"`
    - `advance.flow.back_label` = `"Retour au profil"`
    - `advance.flow.situation.title` = `"Situation actuelle"`
    - `advance.flow.situation.cycle_day` = `"Jour {day} sur 30"` (reuses the `day` placeholder shape from `members.profile.field.cycle_day`; could alias but keep separate for clarity)
    - `advance.flow.situation.contributed` = `"Versé : {amount} FCFA"`
    - `advance.flow.situation.advances` = `"Avances en cours : {amount} FCFA"`
    - `advance.flow.suggested_label` = `"Montants suggérés"`
    - `advance.flow.amount_input.label` = `"Montant du prêt (FCFA)"`
    - `advance.flow.amount_input.helper` = `"Ou choisissez un montant suggéré ci-dessus."`
    - `advance.flow.cta_grant` = `"Accorder le prêt"`
    - `advance.flow.cta_disabled_tooltip` = `"Saisissez un motif et l'acquittement (Story 5.3)"`  *(temporary — Story 5.3 will replace with a user-facing copy or remove entirely once the gate logic ships)*
    - `advance.flow.error.load` = `"Impossible de charger ce membre. Réessayez."`
    - 12 keys total.

14. **Tests — vitest + RTL.**
    - **Component test** `src/features/transaction/ui/AdvanceFlow.test.tsx`:
      - Mock `useMemberProfile` to return a happy-path member + cycle + transactions (with 1 existing advance for non-zero situation).
      - Assert situation panel renders 3 facts with the right values.
      - Assert 3 suggested-amount chips render with the right labels.
      - Tap a chip → assert the amount input value updates AND the AdvanceSimulationPanel's row 3 reflects it.
      - Type a custom amount in the input → simulation panel updates.
      - Suggested chip that would over-limit → disabled state.
      - Empty input → simulation panel in empty state.
      - Closed-cycle member → redirect to profile (mock `useNavigate` or use MemoryRouter assertion).
      - Member not found → redirect.
      - Loading state → renders nothing.
      - Error state → error fallback.
      - axe-clean across the happy state.
    - **Route test** in `src/app/router.test.ts` (existing): assert the new route resolves to the AdvanceFlow component for `/members/:id/advance`.
    - **MemberList test extension** `src/features/member/ui/MemberList.test.tsx`: assert tapping the action sheet's "Prêt" link navigates to `/members/:id/advance`.

15. **No new dependencies.** Pure React + React Router v7 + existing i18n + existing TanStack Query cache.

16. **No new migrations / RPC / triggers.** Story 5.2 is purely client-side. Story 5.4 ships the `record_advance` RPC; Story 5.2 has nothing to write.

17. **No suggested-amount domain-level invariant.** The constant `ADVANCE_SUGGESTED_AMOUNTS` is a UX preference, not a math invariant. Don't put it in `src/domain/cycle/cycleEngine.ts`. Future stories may parameterise it per collector / per market — that's a feature-layer concern.

18. **All gates green.**
    - `npm run typecheck` — strict TS clean.
    - `npm run lint` — no new warnings. Cross-feature import: `<AdvanceFlow>` imports from `@/features/member/api/useMemberProfile` — allowed because both are `features/` and the import goes through `useMemberProfile`'s direct export (it's not gated by a barrel; Story 2.4's pattern). If lint complains, route the import through `@/features/member` (the existing barrel `src/features/member/index.ts` exports `useMemberProfile` already).
    - `npm test -- --coverage` — domain still 100 %; new component file ≥ 80 %.
    - `npm run build` — bundle delta < 5 kB gzipped (1 route + 1 screen component + 12 i18n strings).
    - `npx playwright test` — UNCHANGED (Story 5.4's commit-path E2E will exercise this flow end-to-end).

## Tasks / Subtasks

- [ ] **Task 0 — Constant (AC #5 #17).** New `src/features/transaction/api/advanceConstants.ts` exporting `ADVANCE_SUGGESTED_AMOUNTS = [50_000, 100_000, 150_000] as const`. 1-line test asserting the exact value.

- [ ] **Task 1 — `<AdvanceFlow>` component (AC #2 #4 #5 #6 #7 #8 #9 #10 #11 #12).** Create `src/features/transaction/ui/AdvanceFlow.tsx`:
  - Imports `useMemberProfile`, `<AdvanceSimulationPanel>`, `useT`, `useNavigate`, `formatFcfaAmount`, `isCycleClosedForTransactions`, `<Link>`, `<Navigate>`.
  - Local `useState<string>` for the input + `useMemo` for `candidateAmount`.
  - Memoised `existingAdvanceAmounts` from `data.transactions.filter(...)`.
  - Conditional renders for loading / error / not-found / closed-cycle / no-active-cycle / happy.
  - Layout: header (back link + title) → situation card → suggested chips → amount input → simulation panel → disabled CTA.

- [ ] **Task 2 — Route file (AC #1).** Create `src/app/routes/members/[id].advance.tsx`. Mirror `[id].edit.tsx`. Reads `:id` via `useParams`, delegates to `<AdvanceFlow>`.

- [ ] **Task 3 — Router wiring (AC #1).** Edit `src/app/router.tsx` to register the new route. Update the comment block in router.tsx lines 1-17 to mention the new route. Update `src/app/router.test.ts` to assert the route resolves.

- [ ] **Task 4 — MemberList wiring (AC #3).** Edit `src/features/member/ui/MemberList.tsx`:
  - Spread `onAdvance` conditionally based on `activeMember.currentCycle`.
  - Handler: `(memberId) => { setActiveMemberId(null); navigate(\`/members/${memberId}/advance\`); }`.
  - Extend `MemberList.test.tsx` with 1 case asserting the navigation.

- [ ] **Task 5 — i18n keys (AC #13).** Add 12 keys under `advance.flow.*` to `src/i18n/fr.json`.

- [ ] **Task 6 — Component tests (AC #14).** New `src/features/transaction/ui/AdvanceFlow.test.tsx`. ≥ 11 cases (happy + chips + input + edge cases + axe-clean).

- [ ] **Task 7 — All gates (AC #18).** `typecheck` / `lint` / `test --coverage` / `build`.

- [ ] **Task 8 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `5-2-advance-situation-context: ready-for-dev → review`.
  - Note in Story 5.3's eventual Dev Notes: "the disabled CTA is wired in 5.2 — 5.3 enables-when-valid; 5.4 commits".

## Dev Notes

### Architecture compliance

- **Layering.** Route (app layer) → screen (`features/transaction/ui/`) → reused hook (`features/member/api/`) + reused component (`components/domain/`). Cross-feature import: `features/transaction` reads from `features/member` — allowed because the cycle-engine consumers are explicitly cross-feature in the architecture (see `architecture.md:1086` — Cycle Management spans `src/domain/cycle/`, `src/features/cycle/`, AND surfaces in `src/features/transaction/` for advance commits). Story 2.4's barrel exports `useMemberProfile` already; reuse that import path.
- **Cite sources.** File header references BDD lines 911-918 + FR24 + UX spec lines 793-823 (Flow 2 mermaid).
- **No domain changes.** All math comes from Story 3.2 + Story 5.1's component. Story 5.2 is purely about composition + layout.
- **Tokens, not hex.** Situation panel uses `bg-info-*` (Informational palette per UX spec line 511); chips use `bg-primary-*` for active state, `bg-card` + `border-hairline` for default. No new tokens.

### Why a dedicated `/members/:id/advance` route (not a modal)

UX spec line 1014 distinguishes routine commits (action sheet, in-place) from ceremony commits (advance, settlement — dedicated screens with explicit verification steps). The advance flow has 3+ steps (situation review → amount entry → motive + ack → commit), and the saver may need to see the simulation alongside the collector. A modal can't accommodate the breadth; a route can. Mirrors Story 7.x settlement-ceremony pattern.

### Why situation panel at the top (and not just baked into the simulation)

The simulation panel (Story 5.1) shows the **future**: total cycle, commission, advance, projected final balance. The situation panel shows the **present**: where the cycle is RIGHT NOW (day, contributed, existing advances). Different temporal framing, different info. UX spec line 915 demands both: *"a situation panel at the top displays: cycle day of 30, contributed so far (FCFA), existing advances (FCFA)"*.

### Why a string `useState` for the input (not a number)

`<input type="number">` with `value={number}` would coerce the user's partial typing immediately. Typing "5", "0", "0", "0" would render "5" → "50" → "500" → "5000" — fine in this case. But typing "0" first would render "0" forever (parseInt("0") === 0; never bumps to anything else). String state preserves the intermediate typing exactly as the user enters it; the derived `candidateAmount` integer is what the simulation panel consumes. Mirrors how form libraries handle numeric inputs (RHF's `valueAsNumber` with a string state internally).

### Why the disabled CTA is shipped in 5.2 (not deferred to 5.3)

Two reasons:
1. **Layout finality.** Shipping the CTA placeholder means Story 5.3 only changes the gate logic + Story 5.4 only changes the handler — no layout churn, no QA re-pass on the screen's pixel-perfect look.
2. **Discoverability for the dev agent.** A disabled button with a tooltip referencing Story 5.3 makes the next story's scope visible at the file level. No hidden prerequisite.

### Why the suggested chips aren't in the simulation panel

The simulation panel (Story 5.1) is meant to be reusable in any context that needs an "impact preview" UI. A future Story (e.g., 7.x settlement) could reuse it. Putting the chips inside would couple it to the advance-flow's specific UX. Keep the simulation panel narrow; let the flow surface own its input affordances.

### Anti-patterns (do NOT do)

- **Do NOT** modify Story 5.1's `<AdvanceSimulationPanel>` to accept a "suggested amounts" prop. Composition over configuration — the flow renders the chips alongside the panel.
- **Do NOT** use `<input type="text">`. The numeric keyboard hint on mobile (NFR-A4 outdoor usability) requires `type="number"` + `inputMode="numeric"`.
- **Do NOT** auto-enable the primary CTA in 5.2. Story 5.3 owns the gate.
- **Do NOT** trigger any side effects from typing in the input (no debounced fetch, no autosave). The flow is purely local until commit (Story 5.4).
- **Do NOT** ship a "save draft" button. The advance flow is short-lived; if the collector navigates away, the data is discarded. No FR mandates persistence.
- **Do NOT** put `ADVANCE_SUGGESTED_AMOUNTS` in `domain/cycle/`. UX preference, not domain math.
- **Do NOT** open the flow as a Radix Dialog. It's a route, not a modal.
- **Do NOT** show a sticky bottom bar with "Annuler / Accorder". The back link in the header + the disabled CTA in the body are sufficient at MVP. A sticky bar is a Polish-phase decision.

### Edge cases worth testing

- **Member with `existingAdvances = []`.** Situation panel shows `Avances en cours : 0 FCFA`. All chips enabled.
- **Member with `existingAdvances` summing to `dailyAmount × 29 - 50_000`.** Only the 50k chip is enabled; 100k + 150k disabled (would over-limit). Custom input still allows up to the boundary.
- **Member with closed cycle (direct URL hit).** Redirect to profile.
- **Member with no active cycle (`paused` member status).** Redirect to profile.
- **Member not found / RLS-rejected.** Redirect to /members with toast.
- **Network error during fetch.** Error fallback with retry CTA.
- **Tap a chip then type a custom amount.** Chip's active-state clears (no longer matches `candidateAmount`).
- **Type 0 explicitly.** Empty state in the simulation panel; CTA stays disabled regardless.

### Definition-of-done checklist

- All 18 ACs satisfied + all 9 tasks ticked.
- 1 new constant + 1 new screen component + 1 new route file + router wiring + MemberList wiring + 12 i18n keys + tests.
- ≥ 11 component test cases including jest-axe.
- All gates green.
- Story status set to `review`; sprint-status updated.
- Story 5.3 / 5.4 handshake documented (the disabled CTA + the placeholder tooltip).

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 905-918 (Story 5.2 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` (FR24 — advance flow with situation-in-context + simulation; FR17 — projection formula).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md:1113` (Flow 2 component map: `AdvanceFlow.tsx` lives in `src/features/transaction/ui/`).
  - `_bmad-output/planning-artifacts/architecture.md:1086` (FR15-21 home: `src/domain/cycle/`, `src/features/cycle/`, `supabase/functions/cycle-settlement/`).
- **UX spec:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md:793-823` (Flow 2 mermaid + critical UX details: simulation panel visibility + ≤ 16 ms update budget).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:511` (Informational palette — used for situation panel).
- **Companion stories:**
  - Story 2.4 — `useMemberProfile` (consumed for `member`, `currentCycle`, `transactions`, `stats`).
  - Story 3.2 — `computeMemberStats` (the source of `stats.cycleDay`, `stats.contributedTotal`, `stats.outstandingAdvances`).
  - Story 3.4 — `isCycleClosedForTransactions` (closed-cycle guard).
  - Story 4.1 — `<MemberActionSheet>` (the entry point with optional `onAdvance` prop, wired here).
  - Story 5.1 — `<AdvanceSimulationPanel>` (the consumed component).
  - Story 5.3 — motive + saver ack (gates the CTA — wires here).
  - Story 5.4 — commit RPC + Progressive Toast wiring (commits here).
- **Existing patterns to mirror:**
  - `src/app/routes/members/[id].edit.tsx` (route file pattern).
  - `src/features/member/ui/MemberProfile.tsx` (screen-level component using `useMemberProfile`).
  - `src/components/domain/MemberActionSheet.tsx` (disabled-CTA-with-handler-deferred pattern).
- **Process discipline:** No DB / RPC changes → no `npm run db:migrate` step. Story 5.4 will introduce the migration.

## Dev Agent Record

### Agent Model Used

(filled in by dev agent at implementation time)

### Debug Log References

### Completion Notes List

### File List

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-26 | Winston (architect) | Story 5.2 spec generated by `bmad-create-story`. Ships the Flow 2 advance screen at `/members/:id/advance`: situation panel (cycle day / contributed / existing advances) + 3 suggested-amount chips (`ADVANCE_SUGGESTED_AMOUNTS = [50k, 100k, 150k]`) + free-form numeric input + Story 5.1's `<AdvanceSimulationPanel>` consuming the candidate amount. MemberList's `onAdvance` wires `navigate('/members/:id/advance')`. Closed-cycle / no-active-cycle / not-found redirect to profile defensively. Primary CTA renders DISABLED — Story 5.3 enables-when-valid (motive + saver ack), Story 5.4 commits. No migrations, no RPC, no domain changes. Status → ready-for-dev. |
