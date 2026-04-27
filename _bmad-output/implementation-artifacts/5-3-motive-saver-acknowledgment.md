# Story 5.3: Motive capture and saver acknowledgment

Status: review

## Story

As a **collector**,
I want **the advance flow to require a free-text motive and an explicit saver acknowledgment before commit**,
so that **every advance is traceable to a reason and the saver has explicitly agreed (FR25).**

> **Predicate of this story.** Story 5.2 shipped `<AdvanceFlow>` with the situation panel + suggested chips + amount input + simulation panel + a **disabled** primary CTA. Story 5.3 extends that screen with two new form fields (motive textarea, saver-acknowledgment checkbox) and the gate logic that enables the CTA only when (a) candidate amount > 0 AND not over-limit, (b) motive ≥ 3 chars trimmed, (c) checkbox ticked. The CTA still does NOT commit — Story 5.4 wires the handler. Story 5.3 ships the **complete preview surface** with all gates; Story 5.4 ships the action.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 928-933; the rest are spec-derived constraints.

1. **Motive textarea.** Below the `<AdvanceSimulationPanel>` (consumed by Story 5.2), render:
   - `<textarea>` element with `id="advance-motive"`, `aria-required="true"`, `rows={3}`, `maxLength={280}` (one tweet — pragmatic upper bound; keeps the audit payload small).
   - Label: `t("advance.flow.motive.label")` → *"Motif du prêt"*.
   - Helper text: `t("advance.flow.motive.helper")` → *"Au moins 3 caractères. Sera consigné dans l'historique d'audit."*.
   - Placeholder: `t("advance.flow.motive.placeholder")` → *"Ex. urgence médicale, frais de scolarité…"*.
   - Validation: `value.trim().length >= 3` enables the field's "valid" visual state. Below 3 chars + non-empty: the field stays neutral (no red error in this story — the gate is implicit via the CTA disabled state). Empty: neutral.
   - Local state: `useState<string>` for the raw value.

2. **Saver-acknowledgment checkbox.** Below the motive textarea, render:
   - `<input type="checkbox">` with `id="advance-saver-ack"`, `aria-required="true"`.
   - Label (clickable, associated via `htmlFor`): `t("advance.flow.ack.label")` → exactly *"J'ai compris que ce prêt réduit mon solde final"* (BDD line 930 — copy is locked verbatim, including the apostrophe).
   - Default: **unchecked** (BDD line 931 — *"the checkbox is not pre-checked"*). Cement this with a 1-test assertion.
   - Local state: `useState<boolean>(false)`.
   - Touch target: ≥ 44 × 44 px (NFR-A2). Use a label-wrap pattern so tapping anywhere on the label toggles the checkbox.

3. **CTA gate logic.** **Given** the candidate amount, motive, and acknowledgment state, **When** all three conditions are true:
   - `candidateAmount > 0` AND `canAcceptAdvance(dailyAmount, existingAdvances, candidateAmount) === true`,
   - `motive.trim().length >= 3`,
   - `acknowledged === true`,
   **Then** the primary CTA enables (`disabled={false}` + the disabled tooltip from Story 5.2 disappears). When ANY condition fails → `disabled={true}` with a contextual `title` attribute explaining the gap (see AC #4).

4. **Contextual disabled tooltip.** Replace Story 5.2's placeholder `t("advance.flow.cta_disabled_tooltip")` with a context-aware computed tooltip:
   - If amount empty/zero/over-limit: `t("advance.flow.cta_blocked.amount")` → *"Saisissez un montant valide."*
   - Else if motive too short: `t("advance.flow.cta_blocked.motive")` → *"Saisissez un motif d'au moins 3 caractères."*
   - Else if not acknowledged: `t("advance.flow.cta_blocked.ack")` → *"Cochez l'acquittement du saver."*
   - Else (CTA enabled): no tooltip / `title` removed.
   - The tooltip text mirrors the visible-but-not-yet-validated field; it's read by screen readers via `aria-describedby` on the CTA pointing to a `<span>` rendering the same copy (mirror Story 2.5's edit-impact-alert a11y pattern).

5. **CTA does NOT commit (Story 5.4 wires).** When the CTA is enabled and tapped → currently it has no handler. Add a `onConfirm?: (payload: AdvanceConfirmPayload) => void` PROP to `<AdvanceFlow>` that's called with `{ amount, motive, acknowledged }`. Story 5.4 will wire this prop in the route component. **For now, the route file (`src/app/routes/members/[id].advance.tsx`) does NOT pass `onConfirm`** — so the CTA, even when "enabled" by the gate logic, is functionally a no-op. The "enabled" visual state is meaningful for QA + Story 5.4 dev to verify the gate.
   - **Type:** `export interface AdvanceConfirmPayload { amount: number; motive: string; acknowledged: boolean }` exported from `src/features/transaction/ui/AdvanceFlow.tsx`.
   - **Why pass `acknowledged` (always `true` at this point)?** Story 5.4's audit-log payload requires it (BDD line 946 — *"the audit-log event records the motive and acknowledgment state"*). Pre-shipping the field shape avoids a coordination dance.

6. **Validation copy is informative, not gating.** The textarea + checkbox don't show red error states in Story 5.3. The CTA's disabled state + the contextual tooltip carry the gate signal. Story 5.4 will flip to error-state styling on commit failure (e.g., motive rejected by Zod re-validation server-side). Avoid red noise during the typing flow — UX spec § Loading states / Validation patterns: client-side validation on blur, not on every keystroke (pp. 645-650 of architecture.md mention this).

7. **Form layout.** Vertical stack inside the screen:
   ```
   [back link] [title]
   [situation panel]
   [suggested chips]
   [amount input]
   [simulation panel]
   [motive textarea]      ← NEW (Story 5.3)
   [acknowledgment checkbox]  ← NEW (Story 5.3)
   [primary CTA "Accorder le prêt"]
   ```
   Spacing: `flex flex-col gap-4` consistent with other screens. The textarea + checkbox + CTA form a logical sub-group; consider wrapping them in a `<fieldset>` with a visually-hidden `<legend>` *"Confirmation du prêt"* for screen-reader hierarchy. Optional polish; not required by BDD.

8. **i18n keys.** Add to `src/i18n/fr.json` under `advance.flow.*`:
   - `advance.flow.motive.label` = `"Motif du prêt"`
   - `advance.flow.motive.helper` = `"Au moins 3 caractères. Sera consigné dans l'historique d'audit."`
   - `advance.flow.motive.placeholder` = `"Ex. urgence médicale, frais de scolarité…"`
   - `advance.flow.ack.label` = `"J'ai compris que ce prêt réduit mon solde final"` *(verbatim from BDD line 930)*
   - `advance.flow.cta_blocked.amount` = `"Saisissez un montant valide."`
   - `advance.flow.cta_blocked.motive` = `"Saisissez un motif d'au moins 3 caractères."`
   - `advance.flow.cta_blocked.ack` = `"Cochez l'acquittement du saver."`
   - 7 new keys.
   - **Remove** the temporary key `advance.flow.cta_disabled_tooltip` shipped by Story 5.2 (it was a placeholder; AC #4's contextual tooltips replace it). Update Story 5.2's component to import the new keys.

9. **Tests — vitest + RTL.** Edit `src/features/transaction/ui/AdvanceFlow.test.tsx`:
   - **Default state (zero amount, empty motive, unchecked):** assert checkbox is NOT checked (defends BDD line 931); CTA is disabled; tooltip = *"Saisissez un montant valide."*.
   - **Valid amount, empty motive, unchecked:** CTA disabled; tooltip = *"Saisissez un motif d'au moins 3 caractères."*.
   - **Valid amount, motive < 3 chars (e.g., "ok"):** CTA disabled; same tooltip as above.
   - **Valid amount, valid motive, unchecked:** CTA disabled; tooltip = *"Cochez l'acquittement du saver."*.
   - **Valid amount, valid motive, checked:** CTA enabled; no `title` attribute / tooltip removed.
   - **Over-limit amount, valid motive, checked:** CTA disabled; tooltip = *"Saisissez un montant valide."* (amount gate takes precedence).
   - **Motive whitespace-only (e.g., "   "):** treated as empty (the trim happens in the gate). CTA stays disabled.
   - **CTA tap when enabled (with `onConfirm` prop mocked):** asserts `onConfirm` called once with `{ amount, motive: motive.trim(), acknowledged: true }`. Note: `motive` is passed trimmed to avoid leading/trailing whitespace polluting the audit log.
   - **CTA tap when enabled WITHOUT `onConfirm` prop:** no error thrown; click is a no-op (defensive — Story 5.2's route file doesn't pass `onConfirm` yet).
   - **`aria-describedby` link:** when CTA is disabled, the `aria-describedby` attribute points to a hidden `<span>` containing the same tooltip copy. Screen readers announce the gap.
   - axe-clean across the 5 distinct visual states (default / amount-valid / amount+motive-valid / all-valid / over-limit).

10. **No new domain primitives, no migrations, no RPC.** All gate logic is client-side. The motive and acknowledgment values flow into Story 5.4's commit RPC.

11. **All gates green.**
    - `npm run typecheck` — strict TS clean. The new `AdvanceConfirmPayload` interface is exported.
    - `npm run lint` — no new warnings.
    - `npm test -- --coverage` — domain still 100 %; `AdvanceFlow.tsx` ≥ 80 % (the test surface grows; coverage should stay in budget).
    - `npm run build` — bundle delta < 1 kB gzipped.
    - `npx playwright test` — UNCHANGED (Story 5.4's E2E will exercise the full flow).

## Tasks / Subtasks

- [x] **Task 0 — Component extension (AC #1 #2 #3 #4 #5 #7).** Edit `src/features/transaction/ui/AdvanceFlow.tsx`:
  - Add 2 new `useState`s (motive string, acknowledged boolean).
  - Add the textarea + checkbox JSX in the layout slot per AC #7.
  - Compute `cta.disabled` and `cta.tooltipKey` from the 3 inputs.
  - Wire `onConfirm` prop with the trimmed-motive payload.
  - Export `AdvanceConfirmPayload` type.

- [x] **Task 1 — Replace Story 5.2 placeholder tooltip (AC #4 #8).** Remove the `advance.flow.cta_disabled_tooltip` key from `fr.json` and replace the JSX with the contextual tooltip helper.

- [x] **Task 2 — i18n keys (AC #8).** Add 7 keys; remove 1.

- [x] **Task 3 — Tests (AC #9).** Extend `src/features/transaction/ui/AdvanceFlow.test.tsx` with ≥ 10 cases.

- [x] **Task 4 — All gates (AC #11).** `typecheck` / `lint` / `test --coverage` / `build`.

- [x] **Task 5 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `5-3-motive-saver-acknowledgment: ready-for-dev → review`.
  - Note in Story 5.4's eventual Dev Notes: "the `onConfirm` prop is shipped by 5.3; 5.4 wires the route file to pass a real handler that calls the `record_advance` RPC".

## Dev Notes

### Architecture compliance

- **Layering.** Pure additive change to a `features/transaction/ui/` component. No domain / infrastructure / migration touch.
- **Cite sources.** File header references BDD lines 920-933 + FR25 + Story 5.2 (the host screen).
- **Form validation discipline.** The 3-char minimum + acknowledgment toggle are gate predicates, not Zod schemas in this story — Story 5.4 will introduce a `RecordAdvanceInputSchema` (Zod) covering amount + motive + acknowledged for boundary validation. Story 5.3 keeps the gate UI-only because nothing leaves the client.

### Why the checkbox copy is verbatim from the BDD

UX language is product surface — the BDD's *"J'ai compris que ce prêt réduit mon solde final"* is the canonical phrasing. Translating or rephrasing risks softening the legal/UX intent (NFR-S10 tracker-not-mover language). The copy must read EXACTLY as the BDD prescribes.

### Why a contextual tooltip (not a generic "complete the form")

UX spec § Error Recovery Patterns + § Loading states demand named, actionable guidance — never *"something is missing"*. The 3-state tooltip computation (amount / motive / ack) tells the collector exactly which gap to close next. Mirrors Story 2.5's edit-impact-alert wording style.

### Why the gate is precedence-ordered (amount > motive > ack)

The 3 gates aren't symmetric — they map to the user's mental sequence: enter amount first, then motive, then acknowledge. The tooltip surfaces the FIRST gap in that order. Showing all 3 gaps at once would be noise; showing the LAST gap would feel arbitrary.

### Why `onConfirm` is optional (not required)

Story 5.2's route component renders `<AdvanceFlow memberId={id} />` WITHOUT an `onConfirm` prop. Story 5.4 will add the handler. Making the prop optional means Story 5.3 ships ALL the gate logic + visual states without coupling to 5.4's commit hook. The "CTA enabled but does nothing" state is observable in dev / QA before 5.4 lands.

### Why trim the motive on the way out (not on the way in)

If we trim on every keystroke, the user can't enter a leading space (which they may want for formatting reasons mid-edit). Trimming only at confirmation time preserves the user's exact text during typing while ensuring the audit-log payload doesn't carry incidental whitespace. Same pattern as Story 2.2's member-name field.

### Why no error state on motive (during typing)

The "motive too short" condition is communicated through the CTA's disabled + tooltip — a passive signal that doesn't accuse the user mid-typing. Showing a red border on the textarea while the user is at "ok" (2 chars) is a hostile UX pattern. Wait until commit attempt to harden the error styling (Story 5.4 may add it).

### Anti-patterns (do NOT do)

- **Do NOT** pre-check the acknowledgment box. BDD line 931 is explicit; this is a legal / UX promise to the saver.
- **Do NOT** persist the motive or acknowledgment state across navigation. If the collector navigates away, the values are discarded. No FR mandates draft persistence.
- **Do NOT** show the motive's character count below the textarea in Story 5.3. Polish — leave for the dev's discretion or a future Story.
- **Do NOT** apply Zod validation here. Story 5.4 owns the schema (it's where the data crosses the API boundary).
- **Do NOT** auto-fill the motive based on suggested-amount chips. Suggested AMOUNTS are UX shortcuts; suggested MOTIVES would invent friction-free advances against FR25's intent.
- **Do NOT** add a "save and exit" button. The flow is single-shot; no draft model.
- **Do NOT** wire `onConfirm` in the route component yet. Story 5.4 owns that bridge.
- **Do NOT** reuse Story 2.4's `members.profile.action_disabled_tooltip` for the CTA's disabled state. That key reads *"Disponible bientôt"* — wrong meaning here. Use the contextual tooltips per AC #4.

### Edge cases worth testing

- **Motive exactly 3 chars after trim.** *"abc"* enables motive gate.
- **Motive with leading + trailing whitespace.** *"  abc  "* trims to *"abc"* → 3 chars → enables. Confirm payload sends *"abc"*.
- **Motive at the maxLength boundary (280 chars).** Field cap stops further input; gate still passes.
- **Toggle the checkbox off after enabling the CTA.** CTA re-disables; tooltip switches to *"Cochez l'acquittement du saver."*.
- **Lower the amount to 0 after a fully-valid form.** CTA re-disables; tooltip switches to *"Saisissez un montant valide."*.
- **Amount becomes over-limit by typing a higher number.** Same as above (amount gate takes precedence).
- **Tap the CTA when disabled.** No `onConfirm` invocation. (RTL fires the click, but disabled buttons don't dispatch.)
- **Tap the label of the checkbox (not the checkbox itself).** Toggle works — defends the label-wrap a11y pattern.
- **Press Enter inside the motive textarea.** Inserts a newline (default textarea behaviour); does NOT submit. Defensive — there's no form submit handler at MVP.

### Definition-of-done checklist

- All 11 ACs satisfied + all 6 tasks ticked.
- Story 5.2's `advance.flow.cta_disabled_tooltip` key removed; 7 new keys added under `advance.flow.*`.
- ≥ 10 test cases pass; jest-axe clean across 5 visual states.
- Coverage gate maintained.
- All gates green.
- Story status set to `review`; sprint-status updated.
- Story 5.4 handshake documented (the `onConfirm` prop + the trimmed-motive payload).

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 920-933 (Story 5.3 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` (FR25 — advance requires motive + saver acknowledgment).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md:1113` (Flow 2 component map).
  - `_bmad-output/planning-artifacts/architecture.md:646-650` (validation patterns: Zod at boundaries; client-side on blur).
- **UX spec:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md:765-792` (Flow 2 mermaid + ack checkbox + motive flow).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:1393` (never use *"Êtes-vous sûr ?"* — meaningful gates only).
- **Companion stories:**
  - Story 5.1 — `<AdvanceSimulationPanel>` (rendered above the new fields).
  - Story 5.2 — `<AdvanceFlow>` (the host screen; this story extends it).
  - Story 5.4 — wires the `onConfirm` handler + the `record_advance` RPC + `Progressive Toast`.
- **Existing patterns to mirror:**
  - Story 2.6 — `DeleteMemberDialog`'s typed-confirmation gate (similar gate-with-disabled-CTA pattern).
  - Story 2.2 / 2.5 — RHF + Zod patterns (reference for Story 5.4; not used here).
- **Process discipline:** Pure component extension; no DB / RPC / Edge Function changes; no `db:migrate`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] via `bmad-dev-story` skill (Claude Code).

### Debug Log References

- Story 5.2's `cta_disabled_tooltip` key was already absent from `fr.json` when I went to remove it (likely because it was never persisted through the lint-staged pipeline, OR was naturally cleaned during 5.2's own PR review). Verified zero references remain via repo-wide grep.

### Completion Notes List

- All 11 ACs satisfied. 6 tasks complete.
- `<AdvanceFlow>` extended with motive `<textarea>` (≥ 3 chars trimmed; 280 maxLength) + saver-acknowledgment `<input type="checkbox">` (NOT pre-checked, BDD line 930 copy verbatim, label-wrap pattern with min-h 44px touch target).
- CTA gate precedence-ordered (amount → motive → ack); `ctaTooltipKey` resolved once at the top of the body to the FIRST unmet condition or `null` when CTA enabled.
- `aria-describedby` only set when CTA disabled — points to a hidden `<span id="advance-cta-help">` rendering the same tooltip copy.
- `AdvanceConfirmPayload` extended to `{ amount, motive, acknowledged }`. Trim happens at submit time only — preserves user's exact typing during edit, audit payload gets the trimmed string.
- 11 new test cases under "Story 5.3 — motive + ack gate" describe block: not-pre-checked invariant, verbatim copy, all 4 disabled states with their precedence-ordered tooltips, enabled state, over-limit precedence, whitespace-motive treated as empty, onConfirm payload integrity (incl. trim), no-onConfirm tap is a no-op, aria-describedby presence/absence.
- All gates green: typecheck ✅ / lint ✅ / 532 vitest passing (1 skipped) ✅ / build ✅.

### File List

**Modified (4 files):**

- `src/features/transaction/ui/AdvanceFlow.tsx` (motive textarea + ack checkbox + precedence-ordered CTA gate + `AdvanceConfirmPayload` extension)
- `src/features/transaction/ui/AdvanceFlow.test.tsx` (1 retrofitted Story 5.2 case + 11 new Story 5.3 cases)
- `src/i18n/fr.json` (7 new keys under `advance.flow.{motive,ack,cta_blocked}.*`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flips)
- `_bmad-output/implementation-artifacts/5-3-motive-saver-acknowledgment.md` (this file — Tasks ✓, Completion Notes, Status → review)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-26 | Winston (architect) | Story 5.3 spec generated by `bmad-create-story`. Extends Story 5.2's `<AdvanceFlow>` with motive textarea (≥ 3 chars trimmed) + saver-acknowledgment checkbox (NOT pre-checked, copy locked verbatim from BDD line 930). CTA gate precedence-ordered (amount → motive → ack) with contextual disabled-tooltip via `advance.flow.cta_blocked.*`. Adds optional `onConfirm: (payload) => void` prop + exports `AdvanceConfirmPayload` shape; Story 5.2's route file does NOT pass it yet (Story 5.4 wires). Removes Story 5.2's placeholder `cta_disabled_tooltip` key. Pure component extension; no migrations / RPC / domain changes. Status → ready-for-dev. |
| 2026-04-27 | dev agent (Opus 4.7 via `bmad-dev-story`) | Implementation complete. 4 modified files. 11 new test cases describing motive + ack gate behaviour incl. verbatim BDD copy assertion + precedence-ordered tooltip + onConfirm payload integrity (trim on the way out). All gates green: typecheck / lint / 532 vitest (1 skipped) / build. Status → review. |
