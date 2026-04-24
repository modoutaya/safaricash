# Story 4.2: ProgressiveToast component with state contract

Status: ready-for-dev

## Story

As a **developer**,
I want **a `ProgressiveToast` component that exposes evolving transaction state to the user honestly**,
so that **the collector always knows whether a transaction is queued, syncing, confirmed, or failed — never a silent optimistic lie (UX-DR8).**

> **Predicate.** Story 4.2 ships the **presentation component** + a state-machine type. Story 4.3 owns the wiring (sonner integration, the 5-second undo timer, the SMS-status subscription via `sms_queue`).

## Acceptance Criteria

1. **Component location.** `src/components/domain/ProgressiveToast.tsx` (architecture line 880).

2. **5-state contract.** Single `state` prop drives rendering:
   ```ts
   type ProgressiveToastState =
     | { kind: "just-committed"; secondsLeft: number; memberName: string }
     | { kind: "sending"; memberName: string }
     | { kind: "delivered"; memberName: string }
     | { kind: "offline"; memberName: string }
     | { kind: "failed"; memberName: string };
   ```

3. **State → copy mapping** (BDD lines 818-828):
   - `just-committed` → "Cotisation enregistrée — {name}" + Annuler button + countdown badge "Annuler ({secondsLeft}s)".
   - `sending` → "Envoi du reçu à {name}…" + spinner.
   - `delivered` → "Reçu délivré ✓ — {name}".
   - `offline` → "Hors-ligne — envoi au prochain réseau".
   - `failed` → "Échec de l'envoi — retenter" + Retenter button.

4. **Callback props.**
   - `onUndo?: () => void` — called only from `just-committed`.
   - `onRetry?: () => void` — called only from `failed`.
   - `onDismiss?: () => void` — called from any state.

5. **Pure presentation.** Component does NOT own timers, network state, or sonner integration. Story 4.3 builds the state machine + wires sonner + the 5-second timer + `sms_queue` subscription.

6. **i18n.** Copy lives under `members.toast.*`:
   - `committed` = "Cotisation enregistrée — {name}"
   - `undo_cta` = "Annuler ({secondsLeft}s)"
   - `sending` = "Envoi du reçu à {name}…"
   - `delivered` = "Reçu délivré ✓ — {name}"
   - `offline` = "Hors-ligne — envoi au prochain réseau"
   - `failed` = "Échec de l'envoi — retenter"
   - `retry_cta` = "Retenter"
   - `dismiss_aria` = "Fermer la notification"

7. **Visual contract.** Rendered as a card-style box (`rounded-md border bg-card p-3 shadow-sm`). State-specific tint:
   - `just-committed`, `sending`, `delivered` → primary tint.
   - `offline` → warning tint (`bg-warning-50 text-warning-800 border-warning-200`).
   - `failed` → destructive tint (`bg-destructive/10 text-destructive border-destructive/20`).

8. **Accessibility.**
   - Container `role="status"` for `just-committed`/`sending`/`delivered`/`offline`; `role="alert"` for `failed`.
   - `aria-live="polite"` on the container.
   - Annuler/Retenter/Dismiss buttons are `<button>` with visible labels.
   - Spinner is `aria-hidden`; the textual state is the source of truth for AT.
   - axe-clean asserted by component test.

9. **Tests.** `src/components/domain/ProgressiveToast.test.tsx`:
   - Renders the right copy for each of the 5 states.
   - `just-committed` shows the countdown; clicking Annuler calls `onUndo`.
   - `failed` clicking Retenter calls `onRetry`.
   - Dismiss button calls `onDismiss` from every state.
   - axe-clean.

10. **No sonner integration in this story.** Story 4.3 will mount the component via `toast.custom(<ProgressiveToast .../>)` and own the timer + subscription.

## Tasks / Subtasks

- [ ] **Task 0 — Component.** Create `src/components/domain/ProgressiveToast.tsx`.
- [ ] **Task 1 — i18n.** Add `members.toast.*` namespace.
- [ ] **Task 2 — Component test.** All 5 states + 3 callback paths + axe.
- [ ] **Task 3 — Gates.** typecheck / lint / vitest / build green. No Playwright (component not yet rendered in any flow).
- [ ] **Task 4 — Hygiene.** Story file + sprint-status flip.

## Dev Notes

### Why pure presentation (no internal state)

Story 4.3's `useRecordContribution` hook will own the 5-second undo timer, the transition `just-committed → sending`, the SMS-status subscription, the offline detection, and the sonner mount. Bundling that logic into the component would couple presentation to fetching/timers/sonner — testing becomes painful. Mirrors the pattern from `MemberActionSheet` (Story 4.1).

### Anti-patterns

- **Do NOT add `useState` for state transitions.** Parent owns the state.
- **Do NOT call `toast.custom(...)`** anywhere in this story.
- **Do NOT subscribe to `sms_queue`.** Out of scope.
- **Do NOT compute `secondsLeft`** inside the component.

### Definition-of-done

- All 10 ACs satisfied + 4 tasks ticked.
- typecheck / lint / vitest / build green.
- Story status `review`; sprint-status updated.

## References

- **Epic spec:** `epics.md:808-828` (Story 4.2 BDD).
- **UX:** `ux-design-specification.md:457-466` (Flow 1 toast progression).
- **Architecture:** `architecture.md:880` (component slot), `architecture.md:1112` (Flow 1 component map).
- **Sibling pattern:** `src/components/domain/MemberActionSheet.tsx` (Story 4.1 — pure presentation).
- **Future consumer:** `useRecordContribution` (Story 4.3).

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
| 2026-04-24 | Winston (architect) | Story 4.2 spec generated by `bmad-create-story`. Pure presentation component for Flow 1's evolving-toast UX. 5-state discriminated union driven by props; callbacks for undo/retry/dismiss. Story 4.3 owns timers + sms_queue subscription + sonner integration. Status → ready-for-dev. |
