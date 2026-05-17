# Story 4.6: Replace the MemberActionSheet modal with full-page transaction flows

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector**,
I want to **record a transaction on a dedicated full-page screen instead of the cramped bottom-sheet modal**,
so that **each operation type (cotisation, rattrapage, prêt) gives me clear context and the flow matches the design mockup (`03-mockups.html` — "Nouvelle Transaction" + "Prêt Express")**.

> **Predicate of this story.** Story 4.1 shipped `MemberActionSheet` — a native-`<dialog>` bottom-sheet opened by tapping a `MemberCard`, hosting the four transaction CTAs (record contribution, rattrapage, advance, "montant personnalisé"). Stories 4.3 / 4.4 wired the real handlers; Story 5.2 routed "Prêt" to the full-page `/members/:id/advance` flow. The product owner, during staging QA (2026-05-17), decided the modal should be **replaced** by full pages: a new **"Nouvelle Transaction"** page reached by tapping a member, and the existing **"Prêt Express"** page (`/members/:id/advance` — already a full-page `AdvanceFlow`). This story builds the new page, rewires `MemberCard` tap → navigate, **removes `MemberActionSheet` entirely**, and restyles the existing advance-flow topbar to match the green full-bleed pattern. It is post-Epic-10 QA-driven scope; Epic 4 is reopened to host it. The "montant personnalisé" action (never wired — `MemberActionSheet`'s `onCustomAmount` prop was always undefined) is delivered for the first time as the editable amount field on the new page.

## Acceptance Criteria

> Numbered for traceability. This is QA-driven UI scope — there is no pre-written BDD in `epics.md`. ACs are derived from the mockup (`03-mockups.html` lines 392–441 "Nouvelle Transaction" + 443–543 "Prêt Express") and the product owner's decision.

1. **New route.** `src/app/router.tsx` gains `{ path: "members/:id/transaction", element: <MemberTransactionRoute /> }`, registered AFTER `members/:id` and BEFORE/around the other `:id/*` routes (React Router prefers the longer static segment — same ordering rationale as the existing `:id/edit`, `:id/advance`, `:id/settlement` comment).

2. **New route host — `src/app/routes/members/[id].transaction.tsx`.** Mirrors `[id].advance.tsx`:
   - Validates `:id` is a UUID (reuse the `UUID_REGEX` pattern from `[id].advance.tsx` / `[id].edit.tsx`).
   - Loads the member via `useMemberProfile(id)` — renders `ProfileSkeleton` / `ProfileError` / `ProfileNotFound` for the loading / error / not-found / non-UUID states (same wrapping as `[id].edit.tsx` after its PR #100 rework — non-form states wrapped in `<div className="p-4">`).
   - **Closed-cycle / no-cycle guard:** if `data.currentCycle` is null OR `isCycleClosedForTransactions(currentCycle)` is true → redirect to `/members/:id` (mirror `[id].advance.tsx` lines ~100–102). A closed cycle cannot accept transactions; the profile is the right destination.
   - Owns the mutation hooks (`useRecordContribution`, `useRecordRattrapage`), the toast/undo/offline/error handling, and post-submit navigation. The page component below is pure presentation (the `AdvanceFlow` / `MemberAdvanceRoute` split is the reference).

3. **New page component — `src/features/transaction/ui/NewTransactionForm.tsx`.** Full-page presentation component. Layout follows the mockup + the PR #100 `MemberForm` pattern:
   - **Full-bleed green topbar** — `bg-primary-700` (NOT a gradient — white text must clear WCAG AA 4.5:1; the axe E2E gates this surface; `primary-700` = `#085041` is safe, `primary-500` is not — see `feedback_axe_contrast_jsdom` / the PR #99 lesson). Contains: a back button (`X` icon + "Retour", calls `onBack` → `/members`), the title `t("transaction.new.title")`, the subtitle `t("transaction.new.subtitle")`.
   - **Body** (`p-4`, `flex flex-col gap-4`):
     - The member shown — name + a "Voir le profil" link to `/members/:id` (replaces the sheet's "Voir profil" action; the member-name itself is the link or a discreet text link).
     - **Type selector** — a 3-option segmented control / button row: Cotisation / Rattrapage / Prêt. Selected = `variant="default"` (primary), unselected = `variant="outline"`. Default = Cotisation.
     - Per-type fields (see AC #4, #5, #6).
     - A submit `<Button size="lg" className="w-full">` whose label + behaviour is type-dependent.

4. **Cotisation type.** When type = Cotisation:
   - An amount `<Input type="number" inputMode="numeric">` pre-filled with `member.dailyAmount`, editable (this delivers the long-dormant "montant personnalisé" capability). `min={100} max={100000} step={1}`.
   - Submit label `t("transaction.new.contribution.cta")`; enabled when the amount is a positive integer in [100, 100000].
   - On submit → the route calls `useRecordContribution.mutateAsync({ memberId, cycleId: currentCycle.id, amount, cycleDay: stats.cycleDay })`.
   - **Port the proven handler logic from `MemberList.tsx` lines 287–332 verbatim in behaviour:** `wasOffline` → `showOfflineToast({ memberName })`; online → `showContributionToast({ memberName, onUndo })` where `onUndo` calls `undoTransaction(txId, queryClient)` wrapped in try/catch → `toast.error(t(\`transaction.error.${err.code}\`))` for `UndoTransactionError`, else `t("transaction.error.unknown")`. On `RecordContributionError` with `code === "offline_storage"` → `toast.error(t("transaction.error.offline_storage"))`. After a successful (non-error) submit → navigate back to `/members`.

5. **Rattrapage type.** When type = Rattrapage:
   - A day selector — buttons for `RATTRAPAGE_DAY_OPTIONS` ([2, 3, 4] from `@/domain/cycle`). An option `n` is disabled when `n > daysRemaining` (`daysRemaining = stats.daysRemaining`). Mirror the grid in `MemberActionSheet.tsx` lines 219–243.
   - A live summary line: "{n} jours × {dailyAmount} = {total}" (total = `n × dailyAmount`).
   - Submit label `t("transaction.new.rattrapage.cta")`; enabled when a valid day option is selected.
   - On submit → `useRecordRattrapage.mutateAsync({ memberId, cycleId, dailyAmount, cycleDay: stats.cycleDay, daysCovered: n })`.
   - **Port the rattrapage handler from `MemberList.tsx` lines 333–373:** `wasOffline` → `showOfflineToast`; online → `showRattrapageToast({ memberName, daysCovered, onUndo })`; `RecordRattrapageError` `offline_storage` → `toast.error`. Navigate to `/members` after success.

6. **Prêt type.** When type = Prêt: no inline fields. The submit button label is `t("transaction.new.advance.cta")` ("Continuer vers Prêt Express") and on click navigates to `/members/:id/advance` (the existing full-page `AdvanceFlow` — DO NOT reimplement the advance flow). A short note explains the advance has its own flow with impact simulation + saver acknowledgment.

7. **`MemberCard` tap → navigate.** `src/features/member/ui/MemberList.tsx`: the `MemberCard` `onSelect` prop changes from `(memberId) => setActiveMemberId(memberId)` to `(memberId) => navigate(\`/members/${memberId}/transaction\`)`. `MemberCard.tsx` itself is unchanged (it already calls `onSelect(member.id)`).

8. **Remove `MemberActionSheet`.** Delete `src/components/domain/MemberActionSheet.tsx` and `src/components/domain/MemberActionSheet.test.tsx`. Remove from `MemberList.tsx`: the `MemberActionSheet` import, the `activeMemberId` state, the `activeMember` derivation, the entire `{activeMember ? <MemberActionSheet … /> : null}` block (lines ~252–377), the `useRecordContribution` / `useRecordRattrapage` / `useQueryClient` hooks, and every now-unused import (`showContributionToast`, `showRattrapageToast`, `showOfflineToast`, `undoTransaction`, `UndoTransactionError`, `RecordContributionError`, `RecordRattrapageError`, `toast`, `CYCLE_TOTAL_DAYS`). After removal `MemberList` is purely the list + search + filters + the card list; verify no dangling imports (lint `--max-warnings=0` catches unused).

9. **i18n.** Add a `transaction.new` block to `src/i18n/fr.json` (title, subtitle, back label, member label, "voir le profil", type-selector labels, per-type field labels/helpers/CTAs, the rattrapage summary). The existing `transaction.error.*` keys are reused for error toasts. The `members.action_sheet.*` block becomes dead — remove it (it has no other consumer once `MemberActionSheet` is deleted).

10. **"Prêt Express" topbar restyle.** Restyle the existing `AdvanceFlow` (`src/features/transaction/ui/AdvanceFlow.tsx`) header into the same full-bleed green topbar (`bg-primary-700`, white text, `X`/back) so the "Prêt Express" page matches the mockup and is visually consistent with the new "Nouvelle Transaction" page and the PR #100 `MemberForm`. Keep all `AdvanceFlow` behaviour (situation panel, suggested amounts, simulation, motive, ack, submit gating) unchanged — topbar styling only.

11. **Tests — new page.** `NewTransactionForm.test.tsx`: renders the topbar/title, the 3 type options, defaults to Cotisation with the amount pre-filled to `dailyAmount`; switching type swaps the fields; the rattrapage day-options disable past `daysRemaining`; the Prêt type's CTA triggers the advance-navigation callback; `jest-axe` clean. Route-level wiring (`[id].transaction.test.tsx`) optional smoke test mirroring `[id].advance` testing depth.

12. **Tests — MemberList rewrite.** `src/features/member/ui/MemberList.test.tsx`: the two sheet-exercising tests (~line 289 "card tap opens the action sheet", ~line 532) are rewritten — tapping a `MemberCard` now navigates to `/members/:id/transaction` (assert via a `MemoryRouter` route stub, the pattern already used in `DashboardQuickActions.test.tsx`). Remove all action-sheet assertions.

13. **Tests — delete.** Delete `MemberActionSheet.test.tsx`.

14. **Tests — E2E.** Update the three Flow-1 specs to the new page flow (tap member card → lands on `/members/:id/transaction` → fill → submit, instead of tap → sheet → CTA):
    - `tests/e2e/flow-1-record-contribution.spec.ts`
    - `tests/e2e/flow-1-record-rattrapage.spec.ts`
    - `tests/e2e/flow-1-offline-replay.spec.ts`
    Preserve every existing assertion (the recorded transaction, the toast, the undo step, the offline-replay behaviour) — only the navigation path to reach the record action changes. Run the suite; the axe scans on the new page must pass (hence the `primary-700` topbar, AC #3).

15. **No new dependencies.** All work reuses existing hooks (`useRecordContribution`, `useRecordRattrapage`, `useMemberProfile`), helpers (`showContributionToast`, `showRattrapageToast`, `showOfflineToast`, `undoTransaction`), domain (`RATTRAPAGE_DAY_OPTIONS`, `isCycleClosedForTransactions`), router, and UI primitives (`Button`, `Input`). No npm install, no new RPC, no migration, no DB change.

16. **All gates green.** `npm run typecheck` / `npm run lint` (`--max-warnings=0`) / `npm run test -- --coverage` (global branches ≥ 75%) / `npm run build` / `npx playwright test` (run locally before push — Story 2.5 retro). New files ≥ 80% coverage.

## Tasks / Subtasks

- [ ] **Task 1 — i18n (AC #9).** Add the `transaction.new` block to `fr.json`; remove the dead `members.action_sheet` block.

- [ ] **Task 2 — NewTransactionForm component (AC #3 #4 #5 #6).** Create `src/features/transaction/ui/NewTransactionForm.tsx` — green topbar, member display + profile link, type selector, per-type fields, submit. Pure presentation; props drive everything.

- [ ] **Task 3 — Route host (AC #1 #2).** Create `src/app/routes/members/[id].transaction.tsx` — UUID guard, `useMemberProfile`, loading/error states, closed-cycle redirect, the contribution/rattrapage handlers (ported from `MemberList`), the advance-navigation, post-submit nav. Register the route in `router.tsx`.

- [ ] **Task 4 — Rewire MemberList + remove MemberActionSheet (AC #7 #8).** `MemberCard onSelect` → navigate; strip the sheet block + handlers + unused imports from `MemberList.tsx`. Delete `MemberActionSheet.tsx` + `.test.tsx`.

- [ ] **Task 5 — AdvanceFlow topbar restyle (AC #10).** Restyle `AdvanceFlow.tsx`'s header to the full-bleed `bg-primary-700` green topbar; behaviour untouched.

- [ ] **Task 6 — Unit tests (AC #11 #12 #13).** `NewTransactionForm.test.tsx`; rewrite the sheet tests in `MemberList.test.tsx`; delete `MemberActionSheet.test.tsx`.

- [ ] **Task 7 — E2E (AC #14).** Update the 3 `flow-1-*` specs to the new page flow. Run `npx playwright test` locally.

- [ ] **Task 8 — All gates (AC #16).** typecheck / lint / test --coverage / build / playwright. Fix any regression.

- [ ] **Task 9 — Hygiene + status flip.** Story file Completion Notes + File List + Change Log; `sprint-status.yaml`: `epic-4` stays `in-progress` until the epic retrospective, `4-6-transaction-pages: ready-for-dev → review`.

## Dev Notes

### Architecture compliance

- **Layering.** New route (`app/routes/`) ← new feature component (`features/transaction/ui/`) ← existing hooks (`features/transaction/api/`). No `domain/` change (transaction math already exists). No `infrastructure/` change. No DB/migration/RPC change — this is a UI restructuring over the existing data layer.
- **Reference template.** `[id].advance.tsx` + `AdvanceFlow.tsx` are the canonical "full-page transaction flow" pair — the new route/component split mirrors them exactly (route owns data + mutation + nav; component is pure presentation).
- **Green topbar.** Reuse the pattern shipped in PR #100 `MemberForm.tsx`: `bg-primary-700 px-4 pb-6 pt-4 text-primary-foreground`, an `X`-icon back button, `text-title-1` h1, `text-body-2 text-primary-foreground/90` subtitle. `primary-700` (not `-500`/`-600`) because the axe E2E gates this page and white text needs ≥ 4.5:1 contrast.
- **Cite sources.** New file headers cite the mockup (`03-mockups.html`), Story 4.1 (the modal being replaced), and the reuse of Stories 4.3/4.4/5.2 hooks.

### Reuse — do NOT reinvent

- **Hooks:** `useRecordContribution` (`{memberId, cycleId, amount, cycleDay}` → `{txId, wasOffline}`), `useRecordRattrapage` (`{memberId, cycleId, dailyAmount, cycleDay, daysCovered}` → `{txId, wasOffline}`) — both already do optimistic cache updates + offline IndexedDB queueing internally. Do NOT touch them.
- **Toasts:** `showContributionToast`, `showRattrapageToast`, `showOfflineToast` — the exact handler bodies live in `MemberList.tsx` lines 287–373; port them to the route verbatim (behaviour-identical), do not rewrite.
- **Undo:** `undoTransaction(txId, queryClient)` + `UndoTransactionError` — the 5-second-window undo (Story 4.5) flows from the toast's `onUndo`; unchanged.
- **Member data:** `useMemberProfile(id)` returns `{ member, currentCycle, stats }` where `stats` has `cycleDay`, `daysRemaining` — the route reads `cycleDay` for the RPC and `daysRemaining` to gate rattrapage options.
- **Advance:** the "Prêt" type navigates to the EXISTING `/members/:id/advance`. Do NOT build advance logic on the new page.

### Anti-patterns (do NOT do)

- **Do NOT** keep `MemberActionSheet` "just in case" — delete it and its test. A dead modal is regression surface.
- **Do NOT** reimplement the contribution/rattrapage mutation, toast, undo, or offline logic — port the proven `MemberList` handlers.
- **Do NOT** reimplement the advance flow — the "Prêt" type links to `/members/:id/advance`.
- **Do NOT** use a gradient or `primary-500/600` for the topbar — white text fails WCAG AA there and the axe E2E will fail CI (the PR #99 lesson). Use `bg-primary-700`.
- **Do NOT** leave the `members.action_sheet.*` i18n keys — they have no consumer after the deletion.
- **Do NOT** lose any existing E2E assertion when rewriting the `flow-1-*` specs — only the navigation path changes; the recorded-transaction / toast / undo / offline-replay assertions must all survive.
- **Do NOT** allow a transaction on a closed / absent cycle — redirect to the profile (the `AdvanceFlow` guard precedent).
- **Do NOT** add a member-picker dropdown — the member is fixed by the `:id` route param (the collector tapped a specific member). The mockup's member `<select>` reflects a no-member entry that this story does not build; a "Voir le profil" link covers profile access.

### Flow / navigation

- Today: `/members` → tap `MemberCard` → `MemberActionSheet` (bottom-sheet) → 4 CTAs.
- After this story: `/members` → tap `MemberCard` → **navigate** to `/members/:id/transaction` → choose type → submit → toast → back to `/members`. "Prêt" type → `/members/:id/advance`. "Voir le profil" link → `/members/:id`.
- The dashboard "Cotisation" / "Prêt Express" quick actions (Story 9.1 / PR #97) route to `/members` — unchanged; the collector then taps a member as above. A no-member-context "Nouvelle Transaction" entry (the mockup's member dropdown) is explicitly out of scope.

### Out of scope

- A global "Nouvelle Transaction" entry without a pre-selected member (the mockup's member `<select>`).
- The "✅ Confirmer et Générer Reçu" wording's receipt-generation nuance — receipts already generate server-side on record (Story 6.x); no change.
- Any change to the advance flow's behaviour (only its topbar styling).
- Reordering / redesigning the member-card tap target itself.

### References

- **Mockup:** `_bmad-output/planning-artifacts/03-mockups.html` lines 392–441 ("Nouvelle Transaction"), 443–543 ("Prêt Express").
- **Story 4.1:** `_bmad-output/implementation-artifacts/4-1-member-action-sheet-component.md` — the `MemberActionSheet` being replaced.
- **Reference code:**
  - `src/app/routes/members/[id].advance.tsx` + `src/features/transaction/ui/AdvanceFlow.tsx` — the full-page transaction-flow template.
  - `src/features/member/ui/MemberForm.tsx` (post-PR #100) — the green full-bleed topbar pattern.
  - `src/features/member/ui/MemberList.tsx` lines 252–377 — the sheet wiring + the contribution/rattrapage handler bodies to port.
  - `src/components/domain/MemberActionSheet.tsx` — the modal (to delete); its rattrapage day-grid (lines 219–243) is the model for the page's day selector.
- **Hooks:** `src/features/transaction/api/useRecordContribution.ts`, `useRecordRattrapage.ts`, `useMemberProfile` (member feature).
- **Memory / process:** `feedback_axe_contrast_jsdom` (jsdom axe misses contrast — verify topbar colours), `feedback_responsive_width` (no horizontal overflow on ~360px), run Playwright locally before push.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log

| Date       | Author                                  | Change |
|------------|-----------------------------------------|--------|
| 2026-05-17 | Claude (Opus 4.7) via `bmad-create-story` | Story 4.6 spec generated. QA-driven post-Epic-10 scope (Epic 4 reopened): replaces the `MemberActionSheet` bottom-sheet modal with a new full-page "Nouvelle Transaction" flow (`/members/:id/transaction` — type selector for Cotisation / Rattrapage / Prêt; Cotisation delivers the long-dormant editable "montant personnalisé"; Prêt links to the existing `/members/:id/advance`), rewires `MemberCard` tap → navigate, removes `MemberActionSheet` + its test, and restyles the `AdvanceFlow` ("Prêt Express") topbar to the green full-bleed pattern. Reuses all existing transaction hooks/toasts/undo — no DB/migration/dependency change. Status → ready-for-dev. |
