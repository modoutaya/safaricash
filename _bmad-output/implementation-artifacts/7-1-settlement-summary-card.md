# Story 7.1: SettlementSummaryCard component

Status: review

## Story

As a **developer**,
I want **a reusable `SettlementSummaryCard` component that displays the full settlement math for a member's completed cycle**,
so that **the collector and saver can review the numbers together before commit (UX-DR9, FR21).**

> **Predicate of this story.** Epic 7 opens with the summary card because Story 7.3 (initiation flow), Story 7.4 (re-auth gate + commit), and Story 7.5 (post-settlement SMS) all consume it. Story 7.1 ships the **pure presentation component** — props in, JSX out, zero state machine, zero network, zero re-auth wiring. The cycle-engine `settle(dailyAmount, advances)` primitive from Story 3.2 supplies the final payout; the four rows in the UX spec (contributions / commission / advances / final payout) are derived synchronously from props on each render. No new domain primitives, no migrations, no hooks, no Edge Function. **Mirrors Story 5.1's `AdvanceSimulationPanel` pattern exactly** — same file location, same prop-driven discipline, same `aria-live` semantics, same Tailwind-token coverage.
>
> **What Story 7.1 does NOT ship:**
> - The drill-down to the cycle's transaction list (the "Vérifier les transactions" CTA emits `onVerifyTransactions`; the route wiring lives in Story 7.3).
> - Any re-auth flow (the "Confirmer et clôturer" CTA emits `onConfirm`; the password re-auth dialog wiring lives in Story 7.4 — **NOT** SMS-OTP as the BDD originally said; see Dev Notes § "Spec-vs-implementation auth drift").
> - The post-settlement `EnvelopeHandoverScreen` (Story 7.2).
> - Settlement RPC / Edge Function (Story 7.4 + 7.5).
> - Any cycle-status transition (Story 7.4).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1098-1105`; the rest are spec-derived constraints required for a flawless implementation.

1. **4-row anatomy.** **Given** a member with `dailyAmount` and an `advances` array (FCFA integers for each advance booked on the cycle), **When** the card renders, **Then** the body displays exactly 4 rows in this order:
   1. **Contributions total** — sum of contribution + rattrapage amounts captured during the cycle, rendered as a positive number (e.g., *"Cotisations versées"* + amount).
   2. **Commission** — prefixed with `−` and tinted `text-text-secondary` = `commission(dailyAmount)` (= `dailyAmount × 1` per Story 3.2 line 28).
   3. **Advances** — prefixed with `−`. If `advances.length === 0`, render *"Aucune avance"* + `0 FCFA`. If `advances.length > 0`, render the sum on the row label line; below the row, render a small *"detail"* sub-list of each advance amount (newest first), or omit the sub-list when only one advance exists. The sub-list uses `text-body-2 text-text-secondary` and `tabular-nums`. **Caller** owns ordering of `advances`; the component renders the array order as given.
   4. **Final payout** — large (`text-amount-large` token), primary-green, bold; value = `settle(dailyAmount, advances)`. Below the row, a subtitle *"à remettre à {memberFirstName}"* (UX spec line 1108).

2. **Header block.** **Above the 4-row breakdown**, render a header with:
   - Avatar (initials, 56×56 px — same size as `MemberProfile`'s header avatar; reuse `memberInitials()` from Story 2.1).
   - Member name (`h2`, `text-title-1`).
   - Cycle date range (`text-body-2 text-text-secondary`, formatted as *"Cycle du {startDate} au {endDate}"* — DD/MM/YYYY in `fr-FR` locale).

3. **CTA block** (footer of the card, **below** the 4 rows):
   - **Secondary CTA**: *"Vérifier les transactions"* — full-width on mobile, `Button variant="outline"`. Fires `onVerifyTransactions(memberId, cycleId)`.
   - **Primary CTA**: *"Confirmer et clôturer"* — full-width on mobile, `Button` (primary-green by default). Fires `onConfirm(memberId, cycleId)`.
   - **Both CTAs are passive in this story.** The component does NOT navigate, does NOT open a dialog, does NOT call any RPC. It emits the callbacks. The route owns the wiring (Stories 7.3 / 7.4).

4. **Three states (mirror UX spec lines 1112-1118).**
   - **Preview** (default): all rows populated; both CTAs enabled.
   - **Submitting** (`isSubmitting === true` prop): both CTAs disabled; the primary CTA shows a spinner + label *"Clôture en cours…"*. Mirrors `ProgressiveToast`'s in-flight state.
   - **Confirmed** (out of scope for 7.1 — Story 7.4 unmounts this card and mounts `EnvelopeHandoverScreen` from Story 7.2; the card itself has no "confirmed" terminal state).

5. **Pure presentation.** Lives at `src/components/domain/SettlementSummaryCard.tsx` per `architecture.md:262` (domain components folder). **No** internal `useState`, **no** `useQuery`, **no** `useEffect` for derived values — every output is derived synchronously from props on each render. Same discipline as `AdvanceSimulationPanel.tsx` (Story 5.1), `MemberActionSheet.tsx`'s presentation core (Story 4.1), `ProgressiveToast.tsx` (Story 4.2).

6. **Props contract.**
   ```ts
   export interface SettlementSummaryCardProps {
     memberId: string;                            // forwarded to onClick callbacks
     memberName: string;                          // header display
     dailyAmount: number;                         // FCFA integer (positive)
     /** Sum of contribution + rattrapage amounts captured for THIS cycle. */
     contributedTotal: number;                    // FCFA integer (>= 0)
     /** FCFA integer per booked advance. Order = caller's display order. */
     advances: ReadonlyArray<number>;             // each positive; empty allowed
     cycleId: string;                             // forwarded to onClick callbacks
     /** ISO date string YYYY-MM-DD. */
     cycleStartDate: string;
     /** ISO date string YYYY-MM-DD. */
     cycleEndDate: string;
     /** When true, both CTAs are disabled and the primary shows the submitting spinner. */
     isSubmitting?: boolean;
     onVerifyTransactions: (memberId: string, cycleId: string) => void;
     onConfirm: (memberId: string, cycleId: string) => void;
     className?: string;
   }
   ```
   - **No `transactions` array.** The component does NOT render the transaction list itself — the "Vérifier" CTA opens a drill-down (Story 7.3 owns the drill-down route). Passing the full transaction array would invite the temptation to render it inline.
   - **`contributedTotal` is a NUMBER, not an array.** Caller has already aggregated. Mirrors `MemberStats.contributedTotal` from Story 3.2's `computeMemberStats()`.
   - **`advances` IS an array** so the component can render the breakdown sub-list per UX spec line 1107 ("advances list" — plural in the spec).

7. **Math — single source of truth.** **Given** the `dailyAmount` and `advances` props, **When** the component computes the final payout, **Then** it MUST call `settle(dailyAmount, advances)` from `@/domain/cycle` (Story 3.2 line 72). It MUST NOT inline the formula `dailyAmount × 29 − Σ(advances)`. Same goes for `commission(dailyAmount)`. **NFR-R3 zero-tolerance**: the payout shown by this card MUST equal to the franc the projected balance any saver-side SMS receipt has shown for the same cycle. The shared cycle-engine module is the only way to guarantee this.

8. **Accessibility — `aria-live` on the final payout.** Mirror UX spec line 1124 and Story 5.1 AC #6: row 4's container gets `aria-live="polite"`. Rows 1-3 do not. The header (member name, cycle dates) does not. Single live region = one focused announcement.

9. **Heading hierarchy.** Per UX spec line 1124, the member name in the header is rendered as an `h2` (the page-level `h1` belongs to the route — Story 7.3 will host this card under `<h1>Clôture du cycle</h1>` or similar). Story 7.1's component MUST NOT emit an `h1`.

10. **Currency formatting.** Use `formatFcfaAmount(amount)` from `src/features/member/api/formatAmount.ts` (Story 2.1). The "FCFA" suffix is appended inline as plain text. Every numeric output (4 rows + advances sub-list) uses tabular-nums.

11. **Date formatting.** Use `Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" })` for `cycleStartDate` and `cycleEndDate`. Instantiate ONCE at module scope (mirror Story 2.4's `PREVIOUS_CYCLE_DATE_FORMATTER` pattern in `MemberProfile.tsx:24-28`). The `cycleStartDate` / `cycleEndDate` props are `YYYY-MM-DD` strings (Story 2.1 `cycleRowSchema` shape); construct `new Date(${date}T00:00:00Z)` to avoid local-tz drift.

12. **No hard-coded hex.** All colours go through Tailwind tokens already configured by Story 2.1's design-token pass + Story 5.1's additions:
    - Header avatar bg: `bg-primary-100` + `text-primary-700` (same as Story 2.4 `MemberProfile.tsx:70-72`).
    - Row labels: `text-text-secondary`.
    - Row values (positive): `text-text-primary`.
    - Row 2 commission, row 3 advances negative prefix: `text-text-secondary` (subtle; the `−` sign communicates the deduction without needing destructive red).
    - Row 4 final payout: `text-primary` (SafariCash green).
    - Card border: `border-primary-200` (same as Story 5.1 line 73).
    - Card background: `bg-card`.
    - **Submitting state**: spinner uses Tailwind `animate-spin` on a lucide `Loader2` icon — no custom CSS animation.

13. **i18n keys.** Add to `src/i18n/fr.json` under a new `settlement.*` namespace:
    - `settlement.summary.cycle_range`: *"Cycle du {start} au {end}"*
    - `settlement.summary.row_contributions`: *"Cotisations versées"*
    - `settlement.summary.row_commission`: *"Commission collecteur"*
    - `settlement.summary.row_advances_label`: *"Avances accordées"*
    - `settlement.summary.row_advances_none`: *"Aucune avance"*
    - `settlement.summary.advances_detail_item`: *"Avance {n} : {amount} FCFA"* (n = 1-based index in the array, oldest-first display order)
    - `settlement.summary.row_final_payout`: *"Solde à remettre"*
    - `settlement.summary.payout_subtitle`: *"à remettre à {memberFirstName}"*
    - `settlement.summary.cta_verify`: *"Vérifier les transactions"*
    - `settlement.summary.cta_confirm`: *"Confirmer et clôturer"*
    - `settlement.summary.cta_submitting`: *"Clôture en cours…"*
    - 11 keys total, no pluralisation.

14. **Component file structure.** New `src/components/domain/SettlementSummaryCard.tsx`:
    - 1-line header comment citing BDD lines 1098-1105 + FR21 + Story 3.2 (math source).
    - Exports `SettlementSummaryCard` + `SettlementSummaryCardProps`.
    - Pure functional component. Derive `firstName` from `memberName.split(" ")[0] ?? memberName` once at the top (mirrors Story 6.7 `[id].tsx` route handler line ~189 — same defensive split).
    - No barrel re-export; imported directly: `import { SettlementSummaryCard } from "@/components/domain/SettlementSummaryCard"`. Mirror Story 5.1's no-barrel decision.

15. **Tests — vitest + RTL + jest-axe.** New `src/components/domain/SettlementSummaryCard.test.tsx`. Cases (≥ 9):
    - **Renders all 4 rows + header + 2 CTAs** with sane mock props (`dailyAmount=500`, `contributedTotal=14000`, `advances=[3000]`, etc.). Assert each row's label + amount.
    - **Math correctness**: with `dailyAmount=500, advances=[3000, 2000]`, the final payout row shows `formatFcfaAmount(settle(500, [3000, 2000]))` = `500 × 29 − 5000` = `9 500 FCFA`. Hard-code the expected output to catch any future drift in `settle()`.
    - **Empty advances**: `advances=[]` → row 3 shows *"Aucune avance"* + `0 FCFA`, no sub-list rendered.
    - **Single advance**: `advances=[3000]` → row 3 shows the total `− 3 000 FCFA`, no sub-list (single-advance case omits the sub-list per AC #1).
    - **Multiple advances**: `advances=[3000, 2000, 5000]` → row 3 shows the sum `− 10 000 FCFA`, sub-list renders 3 items with `Avance 1 : 3 000 FCFA` etc.
    - **`isSubmitting` prop**: both CTAs disabled; primary shows the *"Clôture en cours…"* label + spinner icon (`Loader2` with `animate-spin`).
    - **CTA callbacks**: clicking secondary fires `onVerifyTransactions(memberId, cycleId)` with the exact prop values; clicking primary fires `onConfirm(memberId, cycleId)`. Use `vi.fn()` mocks.
    - **`aria-live` placement**: `getByRole("group", { name: /solde à remettre/i })` (or the live container, however we mark it) has `aria-live="polite"`; assert NO other element in the card has it.
    - **Cycle date range formatting**: `cycleStartDate="2026-04-12"`, `cycleEndDate="2026-05-11"` → renders `"Cycle du 12/04/2026 au 11/05/2026"` exactly.
    - **`firstName` subtitle**: `memberName="Awa Diallo"` → subtitle shows *"à remettre à Awa"*; `memberName="Awa"` (single token) → falls back to *"à remettre à Awa"*.
    - **axe-clean across both states** (preview + submitting): no accessibility violations.

16. **No domain changes.** `settle()` and `commission()` from `src/domain/cycle` (Story 3.2) are pre-existing. The 100 % domain coverage gate is unaffected — Story 7.1 is component-layer only.

17. **No new dependencies.** Pure TS + React + Tailwind + lucide-react (`Loader2` for the spinner). All already in `package.json`. No `npm install`.

18. **No new dialog primitive.** Like Story 5.1, the component is a flat card — NOT a `<dialog>`. The route (Story 7.3) decides whether to render it inside a route page, a modal, or a sheet. Story 7.1's tests render it directly into a div container via RTL.

19. **No `use client` directive.** Vite-built SPA; the directive doesn't apply.

20. **No Storybook.** No `.storybook/` directory in the repo. Stories 5.1, 4.1, 4.2 didn't ship Storybook either — this story doesn't change that.

21. **All gates green.**
    - `npm run typecheck` — strict TS clean.
    - `npm run lint` — no new warnings; ESLint cross-feature import rule respected (`SettlementSummaryCard` imports from `@/domain/cycle` — allowed; from `@/features/member/api/formatAmount` and `@/features/member/api/memberInitials` — allowed because `components/domain/` is a SHARED layer per Story 5.1 AC #17).
    - `npm test -- --coverage` — domain still 100 %; the new component file ≥ 80 % branches (the 75 % global gate stays comfortably above 75 %).
    - `npm run build` — bundle delta < 3 kB gzipped (1 component + 11 i18n strings + `Loader2` import already used elsewhere).
    - `npx playwright test` — UNCHANGED (no new E2E; Story 7.4 will add a Flow 3 settlement E2E that exercises this card end-to-end).

## Tasks / Subtasks

- [x] **Task 1 — i18n keys** (AC: #13)
  - Add the 11 `settlement.summary.*` keys to `src/i18n/fr.json` under a new top-level `settlement` namespace.

- [x] **Task 2 — Component file** (AC: #1, #2, #3, #5, #6, #14)
  - New `src/components/domain/SettlementSummaryCard.tsx`.
  - 1-line header comment + props interface + pure functional component.
  - Imports: `settle`, `commission` from `@/domain/cycle`; `formatFcfaAmount`, `memberInitials` from `@/features/member/api/*`; `Button` from `@/components/ui/button`; `useT` from `@/i18n/useT`; `cn` from `@/lib/utils`; `Loader2` from `lucide-react`.

- [x] **Task 3 — Math wiring** (AC: #7)
  - Compute `commissionAmount = commission(dailyAmount)`, `advancesSum = advances.reduce(...)`, `finalPayout = settle(dailyAmount, advances)`. Pass each to its row.

- [x] **Task 4 — Date formatting** (AC: #11)
  - Module-scoped `Intl.DateTimeFormat("fr-FR", {day, month, year})` constant; format both dates via `new Date(\`${iso}T00:00:00Z\`)`.

- [x] **Task 5 — Header block** (AC: #2)
  - Avatar (initials, 56×56) + h2 name + cycle range.

- [x] **Task 6 — 4-row body** (AC: #1, #12)
  - Row 1 contributions / Row 2 commission / Row 3 advances (with sub-list logic) / Row 4 final payout with `aria-live="polite"` + subtitle.

- [x] **Task 7 — Submitting state** (AC: #4)
  - `isSubmitting` prop disables both buttons; primary shows `Loader2` + *"Clôture en cours…"* label.

- [x] **Task 8 — CTA callbacks** (AC: #3)
  - Secondary `<Button variant="outline">` fires `onVerifyTransactions(memberId, cycleId)`.
  - Primary `<Button>` fires `onConfirm(memberId, cycleId)`.

- [x] **Task 9 — Tests** (AC: #15)
  - New `src/components/domain/SettlementSummaryCard.test.tsx` — ≥ 11 cases covering math, states, callbacks, accessibility, date / firstName formatting.

- [x] **Task 10 — Gate run** (AC: #21)
  - `npm run typecheck && npm run lint && npm run test -- --coverage && npm run build` all green locally.

- [x] **Task 11 — Sprint hygiene**
  - Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `7-1-settlement-summary-card` from `ready-for-dev` → `review` once dev completes.
  - Update `last_updated` + touched line in sprint-status.

## Dev Notes

### Why this is a pure component (vs a hook-driven dialog)

Story 7.1's role in Epic 7 is to ship the **visual atom** of the settlement ceremony. The route + flow are deferred to:
- **Story 7.3** — `Clôturer le cycle` entry-point + computation + render of this card.
- **Story 7.4** — password re-auth gate + commit RPC + cycle-status flip.
- **Story 7.2** — post-commit `EnvelopeHandoverScreen` (a SEPARATE component).

Keeping 7.1 dumb (props-driven, callback-emitting, no internal state) lets 7.3 and 7.4 wire it without conflicts. Mirrors how Story 5.1's `AdvanceSimulationPanel` is consumed by Story 5.2 (situation flow) and Story 5.4 (commit) — both stories layer behavior ON the same atom without modifying it.

### Spec-vs-implementation auth drift

The BDD source in `epics.md:1138` says *"the re-auth flow (Story 1.3) is invoked"* and Story 1.3 was the SMS-OTP re-auth Edge Function. **PRD v1.3 pivoted to password re-auth** (Story 1.5b decommissioned the OTP path because of the Termii business-KYC blocker). Story 7.4 will therefore consume the **password** re-auth flow (`/functions/v1/re-auth` POST with `operation_intent: "cycle_settlement"` — already in the `OperationIntentSchema` per `supabase/functions/re-auth/index.ts:55-60`).

**Story 7.1 is unaffected** — the component emits `onConfirm` and the route owns whichever re-auth dialog (password, OTP, biometric — irrelevant to this story). But the spec drift is documented here so Story 7.4's dev does not chase the OTP path.

### Math source of truth (NFR-R3 zero-tolerance)

The cycle engine's `settle(dailyAmount, advances)` is the **ONLY** function that may compute the final payout in this codebase. Re-implementing the formula inline — even "just for this one card" — risks the saver seeing a different number on this card vs. the projected balance from their in-cycle SMS receipts. **NFR-R3 explicitly forbids this drift**: "for any fully-paid cycle, the final balance computed by the app at settlement equals the projected final balance the collector showed the saver earlier in the cycle. Zero-tolerance: any deviation is a P0 bug." (PRD line 85.)

The same `computeProjectedFinalBalance(dailyAmount, sumOfAdvances)` powers both `settle()` and the in-cycle projection (Story 3.2 line 72 — `settle` literally calls `computeProjectedFinalBalance(dailyAmount, sum(advances))`). Reuse propagates correctness.

### Code-reuse map (DO NOT reinvent)

| Need | Existing implementation |
|---|---|
| Final payout math | `settle(dailyAmount, advances)` from `@/domain/cycle` (Story 3.2) |
| Commission math | `commission(dailyAmount)` from `@/domain/cycle` (Story 3.2) |
| FCFA digit grouping | `formatFcfaAmount()` from `src/features/member/api/formatAmount.ts` (Story 2.1) |
| Avatar initials | `memberInitials()` from `src/features/member/api/memberInitials.ts` (Story 2.1) |
| Button primitive | `<Button>` from `src/components/ui/button` (shadcn-skinned, Story 1.x) |
| Tailwind tokens | `tailwind.config.ts` (Story 2.1 design-token pass; `text-amount-large` from Story 5.1; `border-primary-200` from Story 5.1) |
| Spinner icon | `Loader2` from `lucide-react` (already imported elsewhere; `animate-spin` Tailwind utility) |
| i18n hook | `useT()` from `@/i18n/useT` |
| Class helper | `cn` from `@/lib/utils` |
| Date formatter pattern | `PREVIOUS_CYCLE_DATE_FORMATTER` in `src/features/member/ui/MemberProfile.tsx:24-28` (module-scope `Intl.DateTimeFormat` instance — copy the pattern, do not re-import) |

### Anti-patterns to avoid (from past stories' review feedback)

- **DO NOT** import from a feature's `api/types.ts` directly. Per Story 6.7's lint findings, types must come through the feature barrel OR be local. For this story, the only types we need (`SettlementSummaryCardProps`) are LOCAL — no cross-feature type imports required.
- **DO NOT** extract `Intl.DateTimeFormat` calls inside the render — instantiate at module scope (same lesson from Story 5.1 AC #5).
- **DO NOT** wrap the math computation in a `useMemo` — props are integers / shallow arrays; the function is already pure-arithmetic and React's reconciler doesn't re-render unless props change. Memoisation here just adds noise.
- **DO NOT** add a separate "preview / submitting" state machine in React state — `isSubmitting` is a prop driven by the parent (Stories 7.3 / 7.4 own the in-flight state; Story 7.1 just renders the appropriate disabled UI).
- **DO NOT** inline the `dailyAmount × 29 − Σ(advances)` formula. Use `settle()`. See "Math source of truth" above.
- **DO NOT** call `Intl.NumberFormat` directly — use `formatFcfaAmount()` (it already handles NBSP-vs-space; downstream callers depend on consistent output).
- **DO NOT** put `aria-live` on the header (it doesn't change in this story's scope). Only row 4's container gets it.
- **DO NOT** name the primary CTA *"Clôturer"* — UX spec line 1110 specifies *"Confirmer et clôturer"*. Use the spec verbatim.

### Project structure notes

**New files:**
- `src/components/domain/SettlementSummaryCard.tsx`
- `src/components/domain/SettlementSummaryCard.test.tsx`

**Modified files:**
- `src/i18n/fr.json` (11 new keys under `settlement.summary.*`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip)

All paths align with `architecture.md:262` (`src/domain/` shared, `src/components/domain/` shared). No cross-feature import violations.

### Testing standards

- Vitest + React Testing Library + jest-axe.
- Coverage gate (vitest.config.ts): ≥ 80 % global statements / 75 % branches / 80 % functions / 80 % lines. The new component file should hit ≥ 90 % statements thanks to the simple structure.
- The 100 % domain gate on `src/domain/audit/**` and `src/domain/cycle/**` stays unaffected (this story doesn't touch the domain layer).

### Definition-of-done checklist

- All 21 ACs satisfied + all 11 tasks ticked.
- New component file at the canonical path; exports `SettlementSummaryCard` + `SettlementSummaryCardProps`.
- ≥ 11 vitest cases, jest-axe clean across both states.
- All 4 gates green locally: typecheck / lint / `test -- --coverage` / build.
- Story status set to `review`; sprint-status updated; touched-line updated.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 1098-1105 (Story 7.1 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 501 (FR21 — collector initiates settlement, displays final payout), line 85 (NFR-R3 zero-tolerance settlement correctness), line 479 (FR5 — re-auth on settlement, consumed by Story 7.4).
- **UX:** `_bmad-output/planning-artifacts/ux-design-specification.md` lines 1098-1127 (settlement summary card anatomy + states + a11y), line 920 ("pre-commit simulation" principle), line 921 ("ceremony surface for trust moments"), line 793-810 (Flow 3 — Cycle Settlement diagram).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` line 262 (`src/components/domain/` shared-layer location), line 110 (cycle-engine correctness, NFR-R3), line 691 (re-auth gate on every sensitive operation).
- **Story 5.1 (closest analog):** `_bmad-output/implementation-artifacts/5-1-advance-simulation-panel.md` — same pure-component / cycle-engine-consumer pattern. Settlement card mirrors this story's discipline almost line-by-line.
- **Story 3.2 (math source):** `src/domain/cycle/cycleEngine.ts:72` (`settle(dailyAmount, advances)`) — the canonical settlement payout. Re-derived in Story 3.2's property-based tests with `INV-2` (NFR-R3) coverage.
- **Story 2.1 (avatar + format):** `src/features/member/api/formatAmount.ts`, `src/features/member/api/memberInitials.ts`.
- **Story 2.4 (date formatter pattern):** `src/features/member/ui/MemberProfile.tsx:24-28` — module-scope `Intl.DateTimeFormat`.
- **Story 1.5b (re-auth Edge Function — consumed by Story 7.4, NOT 7.1):** `supabase/functions/re-auth/index.ts` — `operation_intent: "cycle_settlement"` is already in the schema (line 55).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- Initial lint run flagged `no-irregular-whitespace` on regex character classes that inadvertently embedded U+00A0 (NBSP) literals — replaced with explicit ` ` escapes (mirrors Story 5.1 `AdvanceSimulationPanel.test.tsx` pattern).

### Completion Notes List

- **Pure presentation component implemented** at `src/components/domain/SettlementSummaryCard.tsx` — 4 rows (contributions / commission / advances / final payout), header block with avatar + h2 + cycle range, two CTAs ("Vérifier les transactions" outline + "Confirmer et clôturer" primary with submitting state). Mirrors Story 5.1 `AdvanceSimulationPanel` discipline: zero state, zero hooks, zero side effects, derived synchronously from props each render.
- **Math source of truth (NFR-R3 zero-tolerance)** — `commission(dailyAmount)` and `settle(dailyAmount, advances)` imported from `@/domain/cycle` (Story 3.2). NO inline formula. The final payout shown by this card is byte-equal to the projected balance any saver-side SMS receipt has displayed for the same cycle.
- **Date formatter** — single module-scope `Intl.DateTimeFormat("fr-FR", { day, month, year })` instance (`CYCLE_DATE_FORMATTER`) matching Story 2.4 `PREVIOUS_CYCLE_DATE_FORMATTER` pattern. Constructs `new Date(\`${iso}T00:00:00Z\`)` to avoid local-tz drift on `YYYY-MM-DD` props.
- **i18n** — 11 keys added under new top-level `settlement.summary.*` namespace in `src/i18n/fr.json`. Type-safe via auto-derived `TranslationKey` from `keys.ts`.
- **Tests** — 13 vitest cases (≥ 11 required) covering: header + 4 rows + 2 CTAs rendering, math correctness (asserts `settle(500, [3000, 2000]) === 9_500` as well as the rendered string), commission, empty advances (no sub-list), single advance (no sub-list per AC #1.3), multiple advances (sub-list with array-order indexing), `isSubmitting` state (both CTAs disabled, primary shows `Loader2` + "Clôture en cours…"), CTA callback wiring with `(memberId, cycleId)`, `aria-live="polite"` is on the final-payout container ONLY (`querySelectorAll('[aria-live="polite"]')` length === 1), date range formatting, firstName subtitle from both two-token and single-token names, contributedTotal positivity, and jest-axe clean across preview + submitting states.
- **Gates (local)** — typecheck clean, lint clean (max-warnings=0), 644 vitest tests passed (was 624 → +20 surface, of which 13 are this story's), coverage thresholds passed (75.45 % branches global ≥ 75 % gate; SettlementSummaryCard at 100 % stmts / 90.9 % branches / 100 % funcs / 100 % lines), domain coverage still 100 % (unchanged), build clean (754.49 kB → 218.84 kB gzipped, no chunk-size regression beyond the existing 500 kB warning).
- **Single uncovered branch on the new file** — the `?? memberName` fallback on the `memberName.split(" ")[0]` extraction is unreachable in practice (String.prototype.split always returns at least one element). Spec AC #14 explicitly requests the defensive `??` — keeping it for spec fidelity rather than chasing 100 % via a synthetic test.
- **No new dependencies, no migrations, no domain changes, no Edge Function, no route wiring** — Story 7.1 is component-layer only. Stories 7.3 (route + drill-down) and 7.4 (password re-auth + commit RPC) will consume this component without modifying it.
- **Code-review patches applied (2026-05-13, reviewer = claude-sonnet-4-6):** Verdict "Approve with suggestions" — 0 HIGH, 1 MEDIUM, 3 LOW. All 4 applied:
  - **[MED] `sprint-status.yaml:39`** — `last_updated` YAML field bumped from `2026-05-12` to `2026-05-13` to match the file-header comment (toolings that parse the YAML otherwise read a stale date).
  - **[LOW] `SettlementSummaryCard.tsx:142`** — Replaced the hard-coded `"0 FCFA"` literal in the empty-advances branch with `` `${formatFcfaAmount(0)} FCFA` `` for full consistency with AC #10 ("every numeric output uses `formatFcfaAmount`"). Behavior unchanged today; protects against any future format change in `Intl.NumberFormat`.
  - **[LOW] `SettlementSummaryCard.test.tsx`** — Added `beforeEach(() => vi.clearAllMocks())` inside the `describe` block to isolate the two `vi.fn()` mocks defined at module-scope in `baseProps` (preventive — no test currently shares the mocks, but future additions are now safe).
  - **[LOW] `SettlementSummaryCard.test.tsx`** — Strengthened test #1 to assert the DOM ordering of the 4 row labels via `container.textContent.indexOf(...)` chain. A future accidental row reorder is now caught (AC #1 explicitly requires "exactly 4 rows IN THIS ORDER").
- **Gates re-run after patches** — 13/13 focused tests green, typecheck + lint clean.

### File List

**New files:**
- `src/components/domain/SettlementSummaryCard.tsx` — pure presentation component (≈170 LOC).
- `src/components/domain/SettlementSummaryCard.test.tsx` — 13 vitest + RTL + jest-axe cases.

**Modified files:**
- `src/i18n/fr.json` — added 11 `settlement.summary.*` keys under a new top-level `settlement` namespace.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-1-settlement-summary-card` → `review`; `epic-7` → `in-progress`; updated `last_updated` + touched line.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-13 | Story 7.1 implemented end-to-end via bmad-dev-story — 11 i18n keys, pure presentation component (math via Story 3.2 `settle()`, module-scope `Intl.DateTimeFormat`, aria-live on final-payout row only, 56×56 avatar, full submitting state with `Loader2` spinner), 13 vitest cases (jest-axe clean across 2 states), all 4 local gates green (typecheck / lint / coverage / build). | Dev (claude-opus-4-7[1m]) |
| 2026-05-13 | Code-review via bmad-code-review on a different LLM (claude-sonnet-4-6) — verdict "Approve with suggestions" (0 HIGH, 1 MEDIUM, 3 LOW). All 4 patches applied: sprint-status `last_updated` field bump, `formatFcfaAmount(0)` consistency in empty-advances branch, `beforeEach(vi.clearAllMocks())` mock isolation, DOM row-ordering assertion in test #1. Gates re-run green. | Reviewer (claude-sonnet-4-6) → Dev (claude-opus-4-7[1m]) |
