# Story 4.1: MemberActionSheet component with pre-filled amount

Status: ready-for-dev

## Story

As a **developer**,
I want **a reusable `MemberActionSheet` component that opens as a bottom-sheet with the member's pre-suggested amount**,
so that **the defining interaction of the product (Flow 1) is implemented as a single component consumed by transaction capture (UX-DR6).**

> **Predicate of this story.** Stories 3.3 + 3.4 pre-shipped the gates this sheet needs: `isCycleClosedForTransactions(cycle)` (the cycle-engine helper) + the i18n key `members.profile.cycle_closed_blocked`. Story 4.1 wires them into the component. The actual transaction-commit logic is Story 4.3 (`useRecordContribution` hook); Story 4.1 ships the **presentation surface** with prop-driven handlers stubbed for the 4 CTAs.

## Acceptance Criteria

> Numbered for traceability. Lines beginning with **Given/When/Then** are the BDD source from `epics.md` lines 800-806; the rest are spec-derived constraints required for a flawless implementation.

1. **Entry point.** **Given** a member tapped from the list, **When** the tap fires, **Then** the action sheet opens. Story 4.1 **changes** the current `MemberCard.onSelect` wiring on `/members`: instead of `navigate(/members/:id)` (Story 2.4 wiring), the tap now `setOpen(true)` on the action sheet. **Profile access moves into the sheet** as a "Voir profil" link (AC #5).

2. **Component shape.** New file `src/components/domain/MemberActionSheet.tsx`. Props:
   ```ts
   interface MemberActionSheetProps {
     open: boolean;
     onOpenChange: (next: boolean) => void;
     member: { id: string; name: string; dailyAmount: number };
     currentCycle: { status: CycleStatus } | null;
     onRecordContribution?: (memberId: string) => void;
     onRattrapage?: (memberId: string) => void;
     onAdvance?: (memberId: string) => void;
     onCustomAmount?: (memberId: string) => void;
     onViewProfile: (memberId: string) => void;
   }
   ```
   The 4 transaction handlers are **optional** — when omitted (Story 4.1's default), the corresponding CTA renders **disabled** with the tooltip `members.profile.action_disabled_tooltip`. Story 4.3 will pass `onRecordContribution`; Stories 4.4/4.5 the others.

3. **Visual contract — header.** **Then** it displays the member avatar, name (`epics.md:802`). Avatar reuses the `memberInitials()` helper + the same circular-primary-100 chip style as Story 2.4's profile header. Member name renders as the dialog's `<h2>` (semantic — assistive tech announces it as the dialog's accessible name via `aria-labelledby`).

4. **Visual contract — primary CTA.** **And** a primary CTA with the amount pre-filled (*"Enregistrer cotisation — 5 000 FCFA"*) (`epics.md:802`). The CTA renders as a full-width `<Button size="lg">` with the localised copy `members.action_sheet.primary_cta` interpolating `{amount}` formatted via `formatFcfaAmount()` (Story 2.1's helper). Disabled when (a) `onRecordContribution` is undefined OR (b) `isCycleClosedForTransactions(currentCycle) === true`.

5. **Visual contract — secondary row.** **And** below the primary CTA, three secondary links: *"Rattrapage"*, *"Prêt"*, *"Montant personnalisé"* (`epics.md:803`). Plus a fourth: *"Voir profil"* (the new home for the profile-access path that the card tap used to provide). Layout: a 2×2 grid of small `<Button variant="ghost">` (or similar low-weight) so the visual emphasis stays on the primary CTA. Each is disabled when the cycle is closed (cycle-closed-blocked copy is shown as a banner above the buttons; the buttons themselves get `disabled={true}`).

6. **Closed-cycle gate.** **Given** `isCycleClosedForTransactions(currentCycle) === true`, the sheet renders an info banner above the CTAs with copy `t("members.profile.cycle_closed_blocked")` ("Le cycle est clôturé. Redémarrez-en un nouveau pour reprendre les cotisations."). All 4 transaction CTAs become `disabled`. The "Voir profil" link stays enabled — the user must still be able to navigate to the profile to restart the cycle (Story 2.7).

7. **Modal behaviour — list visible behind.** **And** the list behind the sheet remains visible (`epics.md:804`). The sheet uses the native `<dialog>` element (consistent with Stories 2.6 + 2.7) with `backdrop:bg-neutral-900/50` (semi-transparent overlay). The sheet itself is bottom-anchored (`m-auto mb-0` + `mt-auto`) so it slides up from the bottom and the list shows through the backdrop.

8. **Dismissal — tap-outside / drag-down / ESC.** **And** tapping outside, dragging down, or ESC dismisses the sheet (`epics.md:805`). Native `<dialog>` handles ESC + closes via `oncancel` event. **Backdrop click** is wired manually: an `onClick` on the `<dialog>` itself (the click target IS the backdrop region outside the inner content `<div>`) calls `onOpenChange(false)`. **Drag-down dismissal** is deferred — full mobile-gesture support is a future polish story (FR/UX backlog), not in 4.1's MVP scope. The `<dialog>` ESC behaviour + tap-outside cover ≥ 95 % of usage.

9. **Focus trap.** **And** focus is trapped inside the sheet while open (Radix Dialog behaviour) (`epics.md:806`). The native `<dialog>` element implements focus trap via `showModal()` (per HTML spec). When the dialog opens, focus moves to the first focusable element (the primary CTA). Tab cycles within the dialog; Tab+Shift cycles backward. `<dialog>` provides this without Radix.

10. **Component file location.** Architecture line 878 places `MemberActionSheet.tsx` under `src/components/domain/`. Story 4.1 honours that path (NOT `src/features/member/ui/`). Reason: the action sheet is a **shared SafariCash domain component** (the same component is consumed by `MemberList`, the future dashboard alert click-through, and the future Flow 2/3 entry points). Cross-feature consumption is the contract — `domain/` is the right home.

11. **Wire-up in `MemberList`.** Edit `src/features/member/ui/MemberList.tsx`:
    - Replace `onSelect={(memberId) => navigate(\`/members/\${memberId}\`)}` with `onSelect={(memberId) => setActiveMemberId(memberId)}`.
    - Render `<MemberActionSheet>` once at the bottom of the list, controlled by `activeMemberId !== null`.
    - Pass `onViewProfile={(id) => navigate(\`/members/\${id}\`)}` so the profile-access path keeps working.
    - The 4 transaction callbacks are NOT passed (rendered disabled per AC #2).

12. **i18n.** New copy under `members.action_sheet.*` in `src/i18n/fr.json`:
    - `primary_cta` = "Enregistrer cotisation — {amount} FCFA"
    - `secondary_rattrapage` = "Rattrapage"
    - `secondary_advance` = "Prêt"
    - `secondary_custom` = "Montant personnalisé"
    - `secondary_view_profile` = "Voir profil"
    - `aria_label` = "Actions pour {name}"

13. **Accessibility.**
    - Dialog has `aria-labelledby` pointing to the member-name `<h2>` (the dialog's accessible name is the member's name).
    - The primary CTA has visible text + adequate touch target (`size="lg"` = 48px height, NFR-A2 minimum).
    - The "Voir profil" link is `<button>` (semantic — the user is opening a modal-to-route transition; not a `<Link>` because it lives inside a controlled-open dialog and we want to close before navigating).
    - axe-clean (asserted by component test).

14. **Tests.**
    - **Component test:** `src/components/domain/MemberActionSheet.test.tsx`. RTL + `vi.mock` for `@/i18n/useT`. Cases:
      - Renders avatar + name + primary CTA with formatted amount (FCFA NBSP separator).
      - All 4 secondary CTAs render.
      - "Voir profil" calls `onViewProfile(member.id)` on click.
      - Primary CTA is disabled when `onRecordContribution` is undefined.
      - All 4 transaction CTAs are disabled when `isCycleClosedForTransactions(currentCycle)` is true; "Voir profil" stays enabled.
      - Closed-cycle banner renders the localised copy.
      - axe-clean (jest-axe).
    - **MemberList test extension:** `src/features/member/ui/MemberList.test.tsx`. Add a case asserting `onSelect` (card tap) opens the action sheet (not navigate). The existing "navigates to /members/:id on card tap" Story 2.4 case is **superseded** — replaced with a "opens action sheet → tap Voir profil → navigates" flow.
    - **No new E2E in Story 4.1.** The action sheet's commit path is Story 4.3's E2E. Story 4.1's surface is covered by component tests.

15. **No transaction commit logic.** Story 4.1 ships the **shell** only. The 4 transaction handlers (`onRecordContribution`, `onRattrapage`, `onAdvance`, `onCustomAmount`) are props that callers wire later (Story 4.3 onward). The component does not call any RPC, mutation hook, or supabase client.

## Tasks / Subtasks

- [ ] **Task 0 — Component skeleton (AC #2 #3 #4 #5 #7 #9 #10).** Create `src/components/domain/MemberActionSheet.tsx`:
  - Native `<dialog>` element (mirror RestartCycleDialog / DeleteMemberDialog patterns).
  - Header: avatar + member name as `<h2>`.
  - Primary CTA full-width with formatted amount.
  - 2×2 grid of 4 secondary buttons (Rattrapage / Prêt / Montant personnalisé / Voir profil).
  - Bottom-anchored layout via Tailwind utilities.
  - Backdrop click dismissal via `onClick` on the `<dialog>` itself.

- [ ] **Task 1 — Closed-cycle gate (AC #6).** Add the conditional banner using `isCycleClosedForTransactions(currentCycle)` and the i18n key `members.profile.cycle_closed_blocked`. Disable all 4 transaction CTAs (Voir profil stays enabled).

- [ ] **Task 2 — i18n (AC #4 #5 #6 #12).** Add the 6 new keys under `members.action_sheet.*` in `src/i18n/fr.json`.

- [ ] **Task 3 — Wire into MemberList (AC #1 #11).** Edit `src/features/member/ui/MemberList.tsx`:
  - Add `useState<string | null>(null)` for `activeMemberId`.
  - Change `onSelect` on `<MemberCard>` to `setActiveMemberId(memberId)`.
  - Render `<MemberActionSheet>` once below the list, deriving `member` + `currentCycle` from the loaded `members` array via `find(m => m.id === activeMemberId)`.
  - Pass `onViewProfile={(id) => navigate(`/members/${id}`)}`.
  - Update `MemberList.test.tsx`: replace the Story 2.4 "navigates on tap" case with the new "opens action sheet → Voir profil navigates" flow.

- [ ] **Task 4 — Component test (AC #14).** Create `src/components/domain/MemberActionSheet.test.tsx` with the cases listed in AC #14.

- [ ] **Task 5 — All gates.**
  - `npm run typecheck` (clean).
  - `npm run lint` (no new warnings).
  - `npm test` (all pass; coverage on the new component lands ≥ 80% statements / 75% branches per the existing `src/components/domain/` thresholds).
  - `npm run build`.

- [ ] **Task 6 — LOCAL Playwright sanity.** Run `npx playwright test`. The existing `flow-2-member-profile.spec.ts` tests "tap card → profile" — that flow now requires "tap card → action sheet → tap Voir profil". Update the spec to reflect the new path.

- [ ] **Task 7 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: status flip + epic-4 → `in-progress` (this is Epic 4's first story).

## Dev Notes

### Architecture compliance

- **Layering.** New component in `src/components/domain/` per architecture line 878 (the architecture's reserved slot — cross-feature shared). NOT in `src/features/member/ui/` (which is single-feature).
- **No new shadcn install.** Reuse `Button`, native `<dialog>`. Same pattern as Stories 2.6 + 2.7. Architecture line 877 lists `MemberActionSheet.tsx` as a domain component, NOT a shadcn primitive.
- **No new dependencies.** Native `<dialog>` provides the focus trap + ESC + modal semantics for free.
- **Tokens, not hex.** All styling via Tailwind tokens.
- **Cite sources.** Component header comment cites BDD lines 800-806, FR22 (PRD line 505), UX § Flow 1 (lines 433-470), UX-DR6.

### Why the card-tap UX changes (justified breaking change)

Currently, tapping a `MemberCard` in `MemberList` calls `navigate(/members/:id)` (Story 2.4 wiring). Story 4.1 changes this to `setActiveMemberId(id)` so the card tap opens the action sheet — matching UX line 438 ("Both paths open the same member action sheet"). Profile access moves into the action sheet as the "Voir profil" button.

This is a UX shift, but it's the **product's defining interaction** (Flow 1: "1 tap to commit a contribution") — getting it right is the entire reason this story exists. The Story 2.4 navigation was a placeholder that always knew Story 4.1 would replace it.

### Why native `<dialog>`, not Radix Dialog

Same call as Stories 2.6 + 2.7: native `<dialog>` provides focus trap + modal semantics for free, zero new deps. The BDD line 806 references "Radix Dialog behaviour" only as a shorthand for "proper focus trap" — the native element delivers identical behaviour. If a future story needs Radix-specific composition (e.g., `Dialog.Trigger` + `Dialog.Portal` for SSR), we install it then; today, native is sufficient.

### Why all 4 transaction CTAs ship disabled in Story 4.1

The component's prop API is the contract Stories 4.3 / 4.4 / 4.5 will consume. By shipping the shell with optional handlers + an undefined → disabled fallback, those future stories can plug in without re-architecting. Alternative: emit `null` placeholders. Optional props are cleaner — no JSX-level type guards at the call site.

### "Voir profil" instead of a chevron / icon

UX line 438 implies the action sheet IS the new entry point — profile becomes a "click through" from the sheet. The "Voir profil" label is explicit, scannable, accessible (vs. an icon that needs `aria-label`). Touch target is ≥ 48px via `<Button size="default">`.

### Anti-patterns (do NOT do)

- **Do NOT add a chevron / icon button on `MemberCard`** to "preserve" tap-to-profile. The card is now action-sheet-trigger only. Profile access lives in the sheet.
- **Do NOT install `@radix-ui/react-dialog`** for this story — native `<dialog>` is sufficient. If Story 4.5 (Prêt with the simulation panel) needs Portal composition, install then.
- **Do NOT wire the transaction handlers** (`useRecordContribution` etc.) in this story. Story 4.3+ owns that.
- **Do NOT implement drag-down dismissal** — out of scope. ESC + backdrop click cover the contract.
- **Do NOT add an animation library** (Framer Motion, etc.). Use Tailwind `transition-transform` + the native `<dialog>` open/close events. Animations are nice-to-have, not blockers.
- **Do NOT block `Voir profil` when the cycle is closed.** The user MUST be able to reach the profile to restart the cycle via Story 2.7's RestartCycleDialog. Only the 4 transaction CTAs disable.

### Edge cases worth testing

- **Member with `currentCycle === null`** (rare; data-state edge): the closed-cycle banner does NOT render (the helper returns false for null). All transaction CTAs are disabled because `onRecordContribution` is undefined in Story 4.1 anyway. "Voir profil" stays enabled.
- **Daily amount = 100 FCFA** (PRD min): primary CTA reads "Enregistrer cotisation — 100 FCFA". No layout overflow.
- **Daily amount = 100 000 FCFA** (PRD max): primary CTA reads "Enregistrer cotisation — 100 000 FCFA" (NBSP separator). No layout overflow.
- **ESC while a CTA has focus**: dialog closes; focus returns to the original card (browser default — `<dialog>` restores focus on close).

### Definition-of-done checklist

- All 15 ACs satisfied + all 7 tasks ticked.
- `MemberActionSheet.tsx` lives under `src/components/domain/`.
- The card tap in `MemberList` opens the action sheet; `Voir profil` navigates to `/members/:id`.
- Closed-cycle gate uses the Story 3.4 helper + i18n key.
- Component test covers the 7 cases in AC #14; axe-clean.
- `MemberList.test.tsx` updated for the new tap-target behaviour.
- `npm run typecheck` / `npm run lint` / `npm run test` / `npm run build` all green.
- **`npx playwright test` (full suite) green LOCALLY before push** (Story 2.5 discipline). The existing `flow-2-member-profile.spec.ts` MUST be updated for the new "tap card → sheet → tap Voir profil" flow.
- Story status set to `review`; sprint-status updated; Epic 4 flipped from `backlog` → `in-progress`.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 788-806 (Epic 4 + Story 4.1 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 505 (FR22 — pre-suggested amount), lines 506-507 (FR23 + FR24 — rattrapage + advance).
- **UX:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md` lines 433-470 (Flow 1 — Daily Contribution; the canonical interaction spec for this story),
  - line 918 (Action-sheet-over-new-screen design principle),
  - line 927 (Entry-point convergence — multiple paths converge on the action sheet).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md` line 878 (`src/components/domain/MemberActionSheet.tsx` slot),
  - line 1112 (Flow 1 component map),
  - line 1136 (transaction-commit flow — Story 4.3 territory).
- **Pre-shipped helpers:**
  - `src/domain/cycle/cycleEngine.ts` — `isCycleClosedForTransactions(cycle)` (Story 3.4).
  - `src/i18n/fr.json` — `members.profile.cycle_closed_blocked` (Story 3.4).
  - `src/features/member/api/memberInitials.ts` — avatar text helper (Story 2.4).
  - `src/features/member/api/formatAmount.ts` — `formatFcfaAmount(n)` (Story 2.1).
- **Existing patterns to mirror:**
  - `src/features/member/ui/RestartCycleDialog.tsx` (native `<dialog>` shell — Story 2.7).
  - `src/features/member/ui/DeleteMemberDialog.tsx` (native `<dialog>` shell with state machine — Story 2.6).
- **Process discipline:** Run Playwright LOCALLY before each push (Story 2.5 retrospective).
- **Layering rules:** `CLAUDE.md` § Operating principles.

## Dev Agent Record

### Implementation Plan
_(populated by dev agent)_

### Completion Notes
_(populated by dev agent)_

### Debug Log
_(populated by dev agent)_

## File List
_(populated by dev agent)_

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-24 | Winston (architect) | Story 4.1 spec generated by `bmad-create-story`. Builds the `MemberActionSheet` component (Flow 1's entry surface) under `src/components/domain/`. Native `<dialog>` shell (no Radix dep), bottom-anchored, focus-trapped. 4 transaction CTAs render disabled in this story (Stories 4.3-4.5 wire the handlers). Closed-cycle gate uses Story 3.4's pre-shipped helper + i18n key. Card tap on `MemberList` changes behaviour: now opens the action sheet (was: navigate to profile). Profile access moves into the sheet via "Voir profil". Status → ready-for-dev. |
