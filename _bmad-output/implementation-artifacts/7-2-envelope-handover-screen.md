# Story 7.2: EnvelopeHandoverScreen component

Status: review

## Story

As a **developer**,
I want **an `EnvelopeHandoverScreen` component that crystallises the day-30 moment of trust**,
so that **the settlement climax is a ceremony, not a form submission (UX-DR10).**

> **Predicate of this story.** Epic 7's emotional climax — the post-commit success screen that follows a settled cycle. Per the discovery framing (UX spec line 70, *"The settlement-day ritual"*), this is the **moment of crystallised trust** the entire product narrative builds toward. Story 7.2 ships the **pure presentation component** — props in, JSX out, zero state machine, zero network, zero re-auth wiring. Story 7.4 (settlement commit + re-auth) will render this component once the commit succeeds; Story 7.5 (final SMS) will own the dispatch the subtext refers to. **Mirrors Story 7.1's `SettlementSummaryCard` pattern exactly** — same `src/components/domain/` location, same prop-driven discipline, same Tailwind-token coverage, same i18n-namespace approach.
>
> **What Story 7.2 does NOT ship:**
> - The settlement Edge Function or `cycles.status = settled` transition (Story 7.4).
> - The final settlement SMS (Story 7.5 — the subtext only *references* its outcome).
> - The navigation logic for the "Retour aux membres" CTA (route owner in Story 7.4 wires this).
> - Any re-auth flow (the precondition for mounting this screen is already-committed settlement — Story 7.4 gates the commit).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1113-1119`; the rest are spec-derived constraints required for a flawless implementation.

1. **Anatomy** (UX spec § 6 *Envelope Handover Screen*, lines 1129-1156). **Given** a successfully-settled cycle, **When** the screen renders, **Then** it displays the following blocks in vertical order:
   1. **Success iconography** — a `lucide-react` `Check` icon centred inside a generous circle (96×96 px, `h-24 w-24`), background `bg-primary` (SafariCash green), icon `text-primary-foreground` (white), `rounded-full`. Icon marked `aria-hidden`.
   2. **Headline** — *"Cycle clôturé"* (`text-title-1`, `font-semibold`, `text-text-primary`, centred).
   3. **Body** — *"Remettez {amount} FCFA à {memberName}."* — the **amount** rendered in the `text-amount-large` token, `font-bold`, `text-primary` (green). Surrounding sentence in `text-body-1`, `text-text-primary`, centred. Amount uses `tabular-nums` inline style + `formatFcfaAmount`.
   4. **Subtext** (conditional — see AC #4) — `text-body-2 text-text-secondary`, centred.
   5. **CTA block** — single full-width primary `Button` with label *"Retour aux membres"*. Fires `onReturnToMembers()`.

2. **Props contract.**
   ```ts
   export interface EnvelopeHandoverScreenProps {
     /** Display name; spec body interpolates `memberName` verbatim. */
     memberName: string;
     /** FCFA integer (positive). Spec mandates `formatFcfaAmount` rendering. */
     payoutAmount: number;
     /** Saver's phone number — used in subtext when present. `null` → subtext is hidden. */
     recipientPhone: string | null;
     /** Default = "sent". When "pending", subtext copy switches to *"Envoi du récapitulatif…"* + `Loader2` spinner. */
     smsState?: "pending" | "sent";
     /** Single-callback CTA. Route owns navigation. */
     onReturnToMembers: () => void;
     className?: string;
   }
   ```
   - **No `cycleId` / `memberId` props** — the route already knows them; the CTA is parameterless (vs. Story 7.1's 2-arg callbacks). Keeps this component dumb.
   - **No `cycleStartDate` / `cycleEndDate`** — the moment-of-trust framing doesn't need the cycle range here; the saver already received it in their cycle history.

3. **Pure presentation.** Lives at `src/components/domain/EnvelopeHandoverScreen.tsx` per `architecture.md:262` (domain components folder, same as Story 7.1). **No** `useState`, **no** `useQuery`, **no** `useEffect` for **derived** values — every output is derived synchronously from props on each render. **ONE exception:** a single `useEffect` is allowed for **mount-time focus** on the CTA (see AC #6). This mirrors Story 4.1's `MemberActionSheet.tsx` ref pattern.

4. **Subtext state machine** (UX spec lines 1140 + 1146). The subtext line has three configurations:
   - `smsState === "sent"` AND `recipientPhone !== null` → render *"Un récapitulatif final vient d'être envoyé par SMS à {phone}."* (interpolate phone).
   - `smsState === "pending"` AND `recipientPhone !== null` → render *"Envoi du récapitulatif…"* alongside an inline `Loader2` icon (`h-4 w-4 animate-spin`, `aria-hidden`). NO phone interpolated.
   - `recipientPhone === null` → **omit the subtext line entirely** (Story 6.5's no-phone saver path; the saver has no phone to send the final SMS to, so claiming "envoyé par SMS" would be a lie). The check icon, headline, body, and CTA still render; the subtext slot disappears.

5. **No animations.** Per UX line 1155 (*"Celebration without gamification — Pride over playfulness, no confetti, no badge unlock"*) **and** UX line 326 (*"Strict animation discipline: ≤ 200 ms, no parallax, no delight animations"*). The only animation permitted is the `animate-spin` on the SMS-pending `Loader2` icon (essential motion, not decorative). The check-mark icon does NOT animate in. The screen does NOT fade in. No Framer Motion.

6. **Focus management — programmatic, on mount.** UX spec line 1152: *"Focus lands on CTA by default, allowing one-tap dismissal."* Implementation:
   - `const ctaRef = useRef<HTMLButtonElement | null>(null);`
   - `useEffect(() => { ctaRef.current?.focus(); }, []);` — empty deps; one-shot mount focus.
   - Pass `ref={ctaRef}` to the `<Button>`.
   - **Do NOT use the `autoFocus` HTML attribute** — ESLint enforces `jsx-a11y/no-autofocus: "error"` (`.eslintrc.cjs:56`). Programmatic focus is the project's accepted pattern and is not flagged by jsx-a11y.

7. **Heading hierarchy.** Per Story 7.1 AC #9 and Story 4.1 MemberActionSheet convention, the component MUST NOT emit an `<h1>` — the route (Story 7.4) owns the page-level heading. Story 7.2's headline (*"Cycle clôturé"*) is rendered as an `<h2>`.

8. **Subtext live-region.** Add `aria-live="polite"` to the subtext container so the *"Envoi du récapitulatif…"* → *"…envoyé par SMS à {phone}…"* transition is announced once the SMS dispatch resolves (Story 7.5 outcome that the route will propagate as a prop). Mirrors Story 7.1's single-live-region discipline. Rows 1-3 (icon / headline / body) and the CTA do not get `aria-live`.

9. **Screen-reader amount announcement** (UX spec line 1153: *"Amount announced in full (currency included) for screen readers."*). The body sentence MUST contain the amount and *"FCFA"* in the **same text node** so SR users hear them together. `formatFcfaAmount(amount)` already groups thousands with NBSP (U+00A0), which screen readers handle as part of the number. No `aria-label` override needed — the inline string *"Remettez 87 000 FCFA à Awa."* reads correctly out of the box (verified pattern in Story 7.1 AC #1.4 / Story 5.1 AC #4).

10. **Currency formatting.** Use `formatFcfaAmount(amount)` from `src/features/member/api/formatAmount.ts` (Story 2.1). Apply `style={{ fontVariantNumeric: "tabular-nums" }}` to the amount span (same pattern as Story 7.1).

11. **Centred layout.** UX spec describes a vertically-centred composition. Implement via `flex flex-col items-center justify-center` on the outer `<section>`, `gap-6` between blocks (icon → headline → body → subtext → CTA). Max width `max-w-md mx-auto` (matches `MemberProfile.tsx:71`).

12. **No hard-coded hex.** All colours go through Tailwind tokens:
    - Check circle: `bg-primary` (SafariCash green) + `text-primary-foreground` (white check on green).
    - Headline: `text-text-primary`.
    - Body sentence: `text-text-primary` (default) + `text-primary` on the amount span.
    - Subtext: `text-text-secondary`.
    - CTA: default `<Button>` variant (primary-green).
    - No raw `#xxxxxx` anywhere.

13. **i18n keys.** Add to `src/i18n/fr.json` under a new top-level `envelope_handover.*` namespace (parallel to Story 7.1's `settlement.summary.*`):
    - `envelope_handover.headline`: *"Cycle clôturé"*
    - `envelope_handover.body`: *"Remettez {amount} FCFA à {memberName}."*
    - `envelope_handover.subtext_sent`: *"Un récapitulatif final vient d'être envoyé par SMS à {phone}."*
    - `envelope_handover.subtext_pending`: *"Envoi du récapitulatif…"*
    - `envelope_handover.cta_return`: *"Retour aux membres"*
    - 5 keys total, no pluralisation. **Interpolation note:** the `body` key contains both `{amount}` AND `{memberName}` interpolation vars. `useT()` already supports multi-var interpolation (see `src/i18n/useT.ts:18`).

14. **Component file structure.** New `src/components/domain/EnvelopeHandoverScreen.tsx`:
    - 1-line header comment citing BDD lines 1113-1119 + UX-DR10 + spec § 6 + the "pride over playfulness" principle.
    - Exports `EnvelopeHandoverScreen` + `EnvelopeHandoverScreenProps`.
    - Imports: `Check, Loader2` from `lucide-react`; `Button` from `@/components/ui/button`; `formatFcfaAmount` from `@/features/member/api/formatAmount`; `useT` from `@/i18n/useT`; `cn` from `@/lib/utils`; `useEffect, useRef` from `react`.
    - No barrel re-export; imported directly: `import { EnvelopeHandoverScreen } from "@/components/domain/EnvelopeHandoverScreen"`.

15. **Tests — vitest + RTL + jest-axe.** New `src/components/domain/EnvelopeHandoverScreen.test.tsx`. Cases (≥ 10):
    - **Renders all anatomy elements** with sane mock props (`memberName="Awa Diallo"`, `payoutAmount=87000`, `recipientPhone="+221 77 123 45 67"`, `smsState="sent"` default): check icon (by class or test-id), `<h2>` headline "Cycle clôturé", body sentence with both amount AND memberName, subtext with phone, CTA. **NO `<h1>` emitted.**
    - **Body interpolation** — `payoutAmount=87000` + `memberName="Awa"` → body `textContent` matches *"Remettez 87 000 FCFA à Awa."* (NBSP-tolerant regex).
    - **Amount uses `formatFcfaAmount`** — assert the amount span shows the NBSP-grouped value (regex `/87[\s ]000/`).
    - **smsState = "pending"** — subtext shows *"Envoi du récapitulatif…"*, contains a `Loader2` (assert `.animate-spin` element exists), and does NOT mention the phone number.
    - **smsState = "sent"** + phone → subtext interpolates phone string verbatim.
    - **recipientPhone = null** — the entire subtext container is absent from the DOM (`queryByText(/récapitulatif/)` returns null); other anatomy still renders.
    - **CTA callback fires** — `fireEvent.click` on the button calls `onReturnToMembers()` once with no args.
    - **Focus management** — after mount, the CTA has DOM focus (`expect(document.activeElement).toBe(buttonEl)`).
    - **aria-live placement** — exactly ONE `[aria-live="polite"]` on the subtext container; absent when `recipientPhone === null`.
    - **No `<h1>`** — `queryByRole("heading", { level: 1 })` is null; **the headline is an `<h2>`** (`getByRole("heading", { level: 2, name: /cycle clôturé/i })`).
    - **axe-clean** across three configurations: (a) `smsState="sent"` + phone, (b) `smsState="pending"` + phone, (c) `recipientPhone=null`.

16. **No domain changes.** Story 7.2 doesn't touch `src/domain/cycle`, `src/domain/audit`, or any other domain primitive. The 100 % domain coverage gate is unaffected.

17. **No new dependencies.** Pure TS + React + Tailwind + lucide-react (`Check` + `Loader2` — both already used elsewhere). All in `package.json`. No `npm install`.

18. **No new dialog primitive.** This is a FULL-screen content component, NOT a `<dialog>`. The route (Story 7.4) decides whether it replaces the previous screen content in-place or transitions via a route change. Story 7.2's tests render it directly into a div container via RTL.

19. **No Storybook.** No `.storybook/` in repo. Stories 5.1, 7.1, 4.1 didn't ship Storybook. This story doesn't change that.

20. **All gates green.**
    - `npm run typecheck` — strict TS clean.
    - `npm run lint` — no new warnings; `jsx-a11y/no-autofocus` rule respected (programmatic focus via `useEffect` + ref, not the `autoFocus` HTML attribute).
    - `npm run test -- --coverage` — domain still 100 %; the new component file ≥ 80 % branches; the 75 % global gate stays comfortably above 75 %.
    - `npm run build` — bundle delta < 3 kB gzipped (1 component + 5 i18n strings; `Check` & `Loader2` already in the bundle).
    - `npx playwright test` — UNCHANGED (no new E2E; Story 7.4 will add the Flow 3 settlement E2E that exercises this screen).

## Tasks / Subtasks

- [x] **Task 1 — i18n keys** (AC: #13)
  - Add the 5 `envelope_handover.*` keys to `src/i18n/fr.json` under a new top-level `envelope_handover` namespace, after the `settlement` namespace. **Implementation note:** the spec listed 5 keys, but inline-styling the `{amount}` portion of the body sentence required splitting the original `body` key into two: `body_amount_prefix` ("Remettez") and `body_recipient` ("à {memberName}."). The amount + " FCFA" sit in a styled JSX `<span>` between them. Final count = **6 keys**. Same total visible copy as the spec; merely a presentation-layer split.

- [x] **Task 2 — Component file** (AC: #1, #2, #3, #14)
  - New `src/components/domain/EnvelopeHandoverScreen.tsx`.
  - 1-line header comment + props interface + functional component (`useRef` for the CTA, single `useEffect` for mount-time focus).
  - Imports: `Check`, `Loader2` from `lucide-react`; `Button` from `@/components/ui/button`; `formatFcfaAmount` from `@/features/member/api/formatAmount`; `useT` from `@/i18n/useT`; `cn` from `@/lib/utils`; `useEffect`, `useRef` from `react`.

- [x] **Task 3 — Anatomy + Tailwind layout** (AC: #1, #11, #12)
  - Outer `<section className="mx-auto flex max-w-md flex-col items-center justify-center gap-6 p-6">`.
  - Icon circle (`bg-primary text-primary-foreground rounded-full h-24 w-24 flex items-center justify-center`, `<Check aria-hidden />` 48 px).
  - `<h2>` headline.
  - Body sentence — amount inline in `text-amount-large font-bold text-primary tabular-nums`, rest in `text-body-1 text-text-primary`.
  - Subtext slot.
  - CTA `<Button ref={ctaRef} onClick={() => onReturnToMembers()}>` (arrow wrap drops the synthetic MouseEvent so the prop signature stays `() => void`).

- [x] **Task 4 — Subtext state machine** (AC: #4, #8)
  - Compute `subtextEl` once at the top of the component:
    - if `recipientPhone === null` → `null` (omit slot entirely).
    - if `smsState === "pending"` → `<p aria-live="polite" …><Loader2 …/> {t("envelope_handover.subtext_pending")}</p>`.
    - else → `<p aria-live="polite" …>{t("envelope_handover.subtext_sent", { phone: recipientPhone })}</p>`.

- [x] **Task 5 — Mount-time focus on CTA** (AC: #6)
  - `const ctaRef = useRef<HTMLButtonElement | null>(null);`
  - `useEffect(() => { ctaRef.current?.focus(); }, []);`
  - Forward `ref={ctaRef}` to `<Button>` — `Button` already uses `React.forwardRef<HTMLButtonElement, ButtonProps>` (verified in `src/components/ui/button.tsx`).

- [x] **Task 6 — Tests** (AC: #15)
  - New `src/components/domain/EnvelopeHandoverScreen.test.tsx` — 11 cases covering anatomy, interpolation, all 3 subtext configurations, CTA callback (with explicit `toHaveBeenCalledWith()` no-args assertion), focus on the CTA after mount via `document.activeElement`, aria-live placement (single live region; absent when `recipientPhone === null`), no `<h1>` emitted, axe-clean × 3 configurations.

- [x] **Task 7 — Gate run** (AC: #20)
  - `npm run typecheck && npm run lint && npm run test -- --coverage && npm run build` all green locally. EnvelopeHandoverScreen.tsx hits 100% / 100% / 100% / 100% (verified in isolation).

- [x] **Task 8 — Sprint hygiene**
  - Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `7-2-envelope-handover-screen` from `ready-for-dev` → `review` once dev completes.
  - Update `last_updated` + touched line in sprint-status.

## Dev Notes

### Why this is a pure component (vs. a hook-driven route page)

Story 7.2's role in Epic 7 is to ship the **emotional climax atom**. The route + commit flow are deferred to:
- **Story 7.4** — settlement Edge Function commit + re-auth gate + mounting THIS component after success.
- **Story 7.5** — the final settlement SMS that the subtext references.
- **Story 7.3** — settlement initiation entry-point + computation (renders Story 7.1's card first).

Keeping 7.2 dumb (props-driven, callback-emitting, single-effect for focus) lets 7.3 / 7.4 / 7.5 wire it without conflicts. **One** small `useEffect` is the only non-pure exception, and it's a one-shot focus side-effect — not a state machine.

### Pride-over-playfulness implementation discipline

The single most important architectural decision in this story is **what we DON'T add**:

- **No Framer Motion** — even a 200 ms fade-in is forbidden per UX line 1155.
- **No confetti library** — `canvas-confetti` or similar MUST NOT be installed (NFR-A0 — no new deps).
- **No animated SVG** — the check-mark renders statically from `lucide-react`.
- **No sound effect** — irrelevant on web mobile anyway.
- **No "badge earned"** — this is settlement, not gamification.
- **No haptic feedback** — `navigator.vibrate` is forbidden here (anti-pattern for a contemplative moment).

The only motion permitted is the `animate-spin` on the SMS-pending `Loader2` icon — that's *essential* motion (state indicator), not *decorative* motion.

### Subtext live-region rationale

When Story 7.4 renders this screen, it can pass `smsState="pending"` if the SMS dispatch is still in flight. Once Story 7.5's SMS-dispatch resolves (the route component listens on a TanStack query or similar), the route updates `smsState` to `"sent"`, swapping the subtext copy. A polite live region announces the change to screen-reader users (*"Un récapitulatif final vient d'être envoyé par SMS à …"*) without yanking focus from the CTA.

If `recipientPhone === null` from the start, the subtext slot never appears, so there's no live-region transition to worry about.

### Focus-on-mount rationale + a11y trade-off

Auto-focusing the CTA on mount is technically a "focus jump" — which is sometimes considered a screen-reader anti-pattern. **The UX spec explicitly requests it** (line 1152: *"Focus lands on CTA by default, allowing one-tap dismissal"*). The reasoning:

- This is a terminal screen (last screen in a 2-3 step flow). The collector EXPECTS to dismiss it.
- The CTA is the ONLY interactive element on the screen.
- Without auto-focus, the user has to tab through static content to reach it.
- The check icon + headline are decorative + informational — screen readers already announce them via the natural reading order before reaching the CTA.

For these reasons we override the default a11y caution. ESLint's `jsx-a11y/no-autofocus` rule remains intact for *new* `autoFocus` HTML attributes; we use **programmatic focus** via `useEffect` + ref, which is not lint-flagged and is the project's existing pattern (`MemberActionSheet.tsx:83`).

### Code-reuse map (DO NOT reinvent)

| Need | Existing implementation |
|---|---|
| FCFA digit grouping | `formatFcfaAmount()` from `src/features/member/api/formatAmount.ts` (Story 2.1) |
| Button primitive (forwardRef compatible) | `<Button>` from `src/components/ui/button` (`React.forwardRef<HTMLButtonElement, ButtonProps>` — verified) |
| Tailwind tokens (`text-amount-large`, `bg-primary`, `text-primary-foreground`, `text-title-1`) | `tailwind.config.ts` (already configured per Story 2.1 + 5.1) |
| Check icon | `Check` from `lucide-react` (already used elsewhere — grep `lucide-react` to confirm; trivially shared) |
| Spinner icon | `Loader2` from `lucide-react` + `animate-spin` (Story 7.1 + `ProgressiveToast.tsx`) |
| `useEffect` + `useRef` pattern | `MemberActionSheet.tsx:83` (Story 4.1) — one-shot mount-time DOM interaction |
| i18n hook | `useT()` from `@/i18n/useT` |
| Class helper | `cn` from `@/lib/utils` |
| Cross-feature import allowlist | `components/domain/` is a SHARED layer — `@/features/member/api/formatAmount` is allowed (Story 5.1 + 7.1 precedent) |

### Anti-patterns to avoid (from past stories' review feedback)

- **DO NOT** use the `autoFocus` HTML attribute — ESLint enforces `jsx-a11y/no-autofocus: "error"` (verified at `.eslintrc.cjs:56`). Use `useEffect` + `useRef` instead.
- **DO NOT** inline the FCFA digit grouping — use `formatFcfaAmount()`.
- **DO NOT** import `Intl.NumberFormat` directly — same lesson from Story 7.1 / 5.1.
- **DO NOT** add `useMemo` over the subtext-state derivation — props are primitives, the function is pure-conditional, and React reconciles cheaply. Memoisation here adds noise.
- **DO NOT** install `canvas-confetti`, `framer-motion`, or any animation library — see "Pride over playfulness".
- **DO NOT** put `aria-live` on the headline or body — those don't change after mount.
- **DO NOT** name the CTA *"Fermer"*, *"Terminé"*, or *"OK"* — UX spec line 1141 specifies *"Retour aux membres"* verbatim.
- **DO NOT** wrap the icon in a button or interactive element — it's decorative.
- **DO NOT** treat `recipientPhone=""` as `null` — empty string is a different signal (corrupt data); the contract says `null` means "no phone available". Don't normalise.

### Project structure notes

**New files:**
- `src/components/domain/EnvelopeHandoverScreen.tsx`
- `src/components/domain/EnvelopeHandoverScreen.test.tsx`

**Modified files:**
- `src/i18n/fr.json` (5 new keys under `envelope_handover.*`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip)

All paths align with `architecture.md:262` (`src/domain/` shared, `src/components/domain/` shared). No cross-feature import violations.

### Testing standards

- Vitest + React Testing Library + jest-axe.
- Coverage gate (vitest.config.ts): ≥ 80 % global statements / **75 % branches** / 80 % functions / 80 % lines. New component should hit ≥ 90 % statements due to its simple structure.
- The 100 % domain gate on `src/domain/audit/**` and `src/domain/cycle/**` stays unaffected.
- For the focus-on-mount test, RTL's `render` synchronously mounts and triggers `useEffect` synchronously in test mode — `document.activeElement` should be the button immediately after `render(...)`. If not, wrap in `await waitFor(...)`. Mirror `MemberActionSheet.test.tsx` if a precedent exists.

### Definition-of-done checklist

- All 20 ACs satisfied + all 8 tasks ticked.
- New component file at the canonical path; exports `EnvelopeHandoverScreen` + `EnvelopeHandoverScreenProps`.
- ≥ 10 vitest cases, jest-axe clean across 3 subtext configurations.
- All 4 gates green locally: typecheck / lint / `test -- --coverage` / build.
- Story status set to `review`; sprint-status updated; touched-line updated.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 1107-1119 (Story 7.2 BDD), line 212 (UX-DR10 component anchor), line 375 (Epic 7 goal — *"`EnvelopeHandoverScreen` crystallises the moment of trust"*).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` — settlement-day correctness (NFR-R3 reused via Story 7.1, irrelevant here), FR21 completion semantics.
- **UX:** `_bmad-output/planning-artifacts/ux-design-specification.md` lines 1129-1156 (component § 6 anatomy + states + a11y), line 70 (*"settlement-day ritual"* discovery framing), lines 209 + 1155 (*"Pride over playfulness"* principle), line 326 (animation discipline ≤ 200 ms), line 565 (`amount-large` typography token), lines 793-810 (Flow 3 settlement diagram).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` line 262 (`src/components/domain/` shared-layer location), line 110 (cycle correctness; settlement is post-commit, so out of scope here).
- **Story 7.1 (sibling component, closest pattern analog):** `_bmad-output/implementation-artifacts/7-1-settlement-summary-card.md` + `src/components/domain/SettlementSummaryCard.tsx` — same pure-component / single-i18n-namespace / Tailwind-token discipline. Story 7.2 is the visual sibling that runs AFTER 7.1's CTA fires + 7.4's commit completes.
- **Story 4.1 (focus + useRef precedent):** `src/components/domain/MemberActionSheet.tsx:73,83` — `useRef<HTMLDialogElement>` + `useEffect` for DOM-side-effect on mount. Story 7.2 mirrors the SHAPE of this pattern (not the semantics — Story 4.1's effect manages `<dialog>` open/close; Story 7.2's effect calls `.focus()` once).
- **Story 6.5 (no-phone saver path):** `members.phone_number` can be `null` post-Story 6.5 — Story 7.2's `recipientPhone: string | null` honours this and degrades gracefully (subtext hidden).
- **Story 7.5 (settlement SMS — Story 7.2 references its outcome):** the subtext's *"envoyé par SMS"* claim depends on Story 7.5 having dispatched the SMS. Story 7.4 will pass `smsState="pending"` during the in-flight period and `smsState="sent"` once Story 7.5's dispatch resolves.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- First focused vitest run: 10/11 passing. The CTA-callback test failed: `expect(onReturnToMembers).toHaveBeenCalledWith()` — `onClick={onReturnToMembers}` was passing the synthetic React `MouseEvent` to the handler. Per spec AC #2 the prop signature is `() => void`. Fixed by wrapping in an arrow: `onClick={() => onReturnToMembers()}`. Re-run: 11/11 green.
- Initial lint failed with `no-irregular-whitespace` on regex character classes that embedded U+00A0 (NBSP) literals — same lesson as Story 7.1 / Story 5.1. Replaced with the explicit ` ` escape (mirrors `AdvanceSimulationPanel.test.tsx` and `SettlementSummaryCard.test.tsx`).
- Coverage table did not list `EnvelopeHandoverScreen.tsx` in the per-file rows. Investigation: the new file is at 100 %/100 %/100 %/100 % (verified in isolation via `--coverage.include`). v8 coverage SUPPRESSES files when all four metrics are at 100 %. The aggregate `components/domain` row still reflects it.

### Completion Notes List

- **Pure presentation component implemented** at `src/components/domain/EnvelopeHandoverScreen.tsx` — 5-block anatomy (check icon circle / `<h2>` headline / body sentence / conditional subtext / single CTA). Mirrors Story 7.1 `SettlementSummaryCard` discipline: zero state, zero hooks beyond `useT` + `useRef` + a single mount-time `useEffect`, zero side effects beyond the focus call, zero network.
- **Pride-over-playfulness compliance** — zero Framer Motion, zero confetti, zero animated SVGs, zero haptics. The only motion is `animate-spin` on the `Loader2` icon when `smsState === "pending"` — essential motion (state indicator), not decorative.
- **Mount-time focus on CTA** — `useRef<HTMLButtonElement>(null)` + `useEffect(() => ctaRef.current?.focus(), [])` — programmatic focus, not the `autoFocus` HTML attribute (project enforces `jsx-a11y/no-autofocus: error` per `.eslintrc.cjs:56`). Verified by a dedicated test: `expect(document.activeElement).toBe(cta)` after `render(...)`.
- **Subtext 3-config state machine** — `recipientPhone === null` → subtext omitted entirely (no fake "envoyé par SMS" claim for no-phone savers per Story 6.5 path); `smsState === "pending"` → `Loader2` + *"Envoi du récapitulatif…"* (no phone interpolated); `smsState === "sent"` → phone interpolated. Single `aria-live="polite"` region on the subtext container — never on icon, headline, body, or CTA.
- **i18n** — 6 keys under new top-level `envelope_handover.*` namespace (spec said 5; the body sentence required splitting into `body_amount_prefix` + `body_recipient` to allow the inline-styled amount span between them — same total visible copy, just a presentation-layer split).
- **CTA callback signature** — `onClick={() => onReturnToMembers()}` arrow wrap drops the synthetic React `MouseEvent` so the prop signature stays `() => void` (spec AC #2). Test asserts `toHaveBeenCalledWith()` with zero args.
- **Tests** — 11 vitest cases (≥ 10 required) covering: anatomy with no-h1 assertion (h2 only), body interpolation with NBSP-tolerant regex, `formatFcfaAmount` rendering, default `smsState="sent"` behaviour, `smsState="pending"` (spinner + copy + no phone), `recipientPhone=null` (subtext entirely absent), CTA callback `(no args)`, programmatic focus on mount, aria-live placement (1 live region; 0 when no phone), and jest-axe clean across 3 subtext configurations.
- **Gates (local)** — typecheck clean, lint clean (max-warnings=0), 655 vitest passed (was 644 → +11), coverage thresholds passed (75.53 % branches global ≥ 75 % gate; EnvelopeHandoverScreen at **100 % stmts / 100 % branches / 100 % funcs / 100 % lines**), domain coverage still 100 %, build clean (754.75 kB → 218.93 kB gzipped — delta from 7.1 baseline = +260 bytes raw / +90 bytes gzipped, well under the 3 kB target).
- **No new dependencies, no migrations, no domain changes, no Edge Function, no route wiring** — Story 7.2 is component-layer only. Story 7.4 (settlement commit) will mount this component once the commit succeeds; Story 7.5 (final SMS) will own the dispatch the subtext refers to.
- **Code-review patches applied (2026-05-14, reviewer = claude-sonnet-4-6):** Verdict "Approve with suggestions" — 0 HIGH, 1 MEDIUM, 3 LOW. All 4 applied:
  - **[MED] `EnvelopeHandoverScreen.tsx:52`** — Added missing `text-center` class on the `pending`-state subtext `<p>`. Without it, multi-line copy (Wolof / Bambara in Story 1.5) would align left instead of centred, contradicting AC #1.4 (*"Subtext (conditional) — centred"*) and AC #11 (*"centred composition"*). The `sent`-state subtext already had `text-center` — patch restores consistency.
  - **[LOW] `EnvelopeHandoverScreen.test.tsx`** — Added explicit assertion for the Check icon in the anatomy test (`container.querySelector(".rounded-full")` + verify its `<svg>` child exists). Closes a silent-regression gap: if the icon were accidentally removed, the previous tests + jest-axe would still pass.
  - **[LOW] `src/i18n/fr.json`** — Added a `_notes` entry documenting why `envelope_handover.body_amount_prefix` and `envelope_handover.body_recipient` are sentence fragments that get assembled around a styled JSX `<span>`. Protects future translators (Story 1.5 Wolof / Bambara) from translating each fragment in isolation.
  - **[LOW] `EnvelopeHandoverScreen.test.tsx`** — Added a 12th test case asserting the `recipientPhone=null + smsState="pending"` combination — `null` must override every `smsState` value (no fake SMS claim for no-phone savers). Closes a coverage hole in the 3-config state-machine (AC #4).
- **Gates re-run after patches** — 12/12 focused tests green, typecheck + lint clean.

### File List

**New files:**
- `src/components/domain/EnvelopeHandoverScreen.tsx` — pure presentation component (≈110 LOC).
- `src/components/domain/EnvelopeHandoverScreen.test.tsx` — 11 vitest + RTL + jest-axe cases.

**Modified files:**
- `src/i18n/fr.json` — added 6 `envelope_handover.*` keys under a new top-level `envelope_handover` namespace.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-2-envelope-handover-screen` → `review`; updated `last_updated` + touched line.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-14 | Story 7.2 implemented end-to-end via bmad-dev-story — 6 i18n keys (5 + body split), pure presentation component (Pride-over-playfulness compliance: 0 decorative animation; 1 useEffect for mount-time programmatic focus on CTA via useRef; 3-config subtext state machine with single aria-live region), 11 vitest+RTL+jest-axe cases (focus-on-mount via document.activeElement; axe-clean × 3 configs), all 4 local gates green (typecheck / lint / 655 vitest / 75.53 % branches global / build). EnvelopeHandoverScreen.tsx at 100 %/100 %/100 %/100 % coverage. | Dev (claude-opus-4-7[1m]) |
| 2026-05-14 | Code-review via bmad-code-review on a different LLM (claude-sonnet-4-6) — verdict "Approve with suggestions" (0 HIGH, 1 MEDIUM, 3 LOW). All 4 patches applied: `text-center` on pending subtext, Check-icon anatomy assertion, `_notes` doc for split i18n key (Story 1.5 prep), pending+null combo test. Gates re-run green (12/12 tests, typecheck, lint). | Reviewer (claude-sonnet-4-6) → Dev (claude-opus-4-7[1m]) |
