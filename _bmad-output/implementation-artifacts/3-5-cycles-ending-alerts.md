# Story 3.5: Identify and surface cycles ending within upcoming window

Status: done

## Story

As a **collector**,
I want **the dashboard to alert me when cycles are about to complete**,
so that **I can plan settlements and avoid being caught off-guard (FR20).**

> **Predicate of this story.** Stories 3.1–3.4 shipped the cycle-engine domain (pure), the status transitions (DB), and the FR19 server-side gate. Story 3.5 closes Epic 3 by surfacing **identification + alerting** in the UI. End-to-end shipment: pure domain selector → feature selector + hook → `<CycleEndingAlert>` component → mount on the dashboard placeholder → tap routes to `/members` filtered to cycles-ending members → per-session dismiss. Story 9.2 (Epic 9) has overlapping BDD; the alert UX shipped here is the canonical implementation — Story 9.2 reduces to "absorb the alert into Story 9.1's full dashboard layout when it lands" (see § Story-9.2 handshake below).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 779-786; the rest are spec-derived constraints required for a flawless implementation.

1. **Configurable window — default 7 days.** **Given** a configurable upcoming-end window with default value `7`, **When** the dashboard loads, **Then** the alert renders the count of members whose current cycle's `daysRemaining` is in `[0, windowDays]` AND whose member is not displayed as `termine`. The window default lives as `DEFAULT_CYCLE_ENDING_WINDOW_DAYS = 7` in `src/domain/cycle/cycleEngine.ts`. No env-var or RPC parameter at MVP — "configurable" is satisfied by the named constant being a single point of edit. PRD allows this latitude (see prd-validation-report-2026-04-18.md:445 — *"'Configurable window' leaves the default to NFR / architect — deliberate flexibility"*).

2. **Pure domain primitives.** Add to `src/domain/cycle/cycleEngine.ts`:
   - `export const DEFAULT_CYCLE_ENDING_WINDOW_DAYS = 7;`
   - `export function daysUntilCycleEnd(cycleDayValue: number): number` — returns `Math.max(0, CYCLE_TOTAL_DAYS - cycleDayValue)`. Pure scalar in/out (INV-7 — no `Date.now()` reads).
   - `export function isCycleInUpcomingEndWindow(cycleDayValue: number, windowDays: number): boolean` — `daysUntilCycleEnd(cycleDayValue) <= windowDays`. Inclusive of day-30 (`daysRemaining = 0`) — a cycle that hits its last calendar day is still "ending soon" until the status trigger flips to `completed` (Story 3.3).

3. **Feature-level selector** at `src/features/cycle/api/selectMembersWithCycleEndingSoon.ts`:
   - Signature `(members: ReadonlyArray<MemberWithMeta>, windowDays: number) => MemberWithMeta[]`.
   - Filters to members where `m.currentCycle !== null` AND `m.displayStatus !== 'termine'` AND `isCycleInUpcomingEndWindow(CYCLE_TOTAL_DAYS - m.currentCycle.dayNumber + (CYCLE_TOTAL_DAYS - m.currentCycle.dayNumber === 0 ? 0 : 0), windowDays)` — i.e., we already have `dayNumber` in the view-model from Story 2.1's `computeCycleDay`; the selector calls `isCycleInUpcomingEndWindow(m.currentCycle.dayNumber, windowDays)`. **No new RTT** — derived from the existing `useMembers()` cache.
   - Pure / synchronous / unit-testable.

4. **TanStack hook** at `src/features/cycle/api/useCyclesEndingAlert.ts`:
   - Signature `useCyclesEndingAlert(windowDays?: number) => { count: number; members: MemberWithMeta[]; isDismissed: boolean; dismiss: () => void; isLoading: boolean }`.
   - Internally calls `useMembers()` (Story 2.1 cache) → applies `selectMembersWithCycleEndingSoon` → reads `sessionStorage` for the per-session dismiss flag (key `sc_cycle_ending_alert_dismissed`; value `"1"` after dismiss). `dismiss()` writes the flag + triggers a local `useState` re-render.
   - **No new query key.** This hook is a derivation, not a fetch.
   - Default `windowDays = DEFAULT_CYCLE_ENDING_WINDOW_DAYS`.

5. **`<CycleEndingAlert>` component** at `src/features/cycle/ui/CycleEndingAlert.tsx`:
   - Reads from `useCyclesEndingAlert()`.
   - Renders nothing when `count === 0` OR `isDismissed === true` OR `isLoading === true` (no skeleton flash on the dashboard).
   - When visible: a banner using the **Warning / Attention** semantic palette (UX spec line 509: BG `#FAEEDA`, text `#633806`, accent `#854F0B`) — Tailwind tokens `bg-warning-50 text-warning-900 border-warning-200` if available; otherwise the closest existing tokens (the dev should grep the Tailwind config for the warning palette and use semantic class names, NOT hard-coded hex — CLAUDE.md anti-pattern).
   - **Layout:**
     - Title: `t("dashboard.cycles_ending.title")` → *"Cycles se terminant cette semaine"*.
     - Body: `t("dashboard.cycles_ending.body", { count })` → *"{count} membre(s) — clôture imminente"*. Uses `count_label_*` style pluralisation (zero / one / many) — see § Pluralisation note in Dev Notes.
     - Primary CTA (link): `t("dashboard.cycles_ending.cta")` → *"Voir"*. `<Link to="/members?filter=cycles-ending">`.
     - Dismiss button: `aria-label={t("dashboard.cycles_ending.dismiss_aria")}` (*"Masquer cette alerte"*) — a `<button>` with an `×` glyph (Lucide `X`). On click → `dismiss()`.
   - **a11y:** `role="status"` + `aria-live="polite"` on the banner; the dismiss button is a focusable `<button type="button">` with the aria-label above; both the "Voir" link and the dismiss button are keyboard-accessible (the `<Link>` is a focusable anchor by default).
   - **Touch targets:** dismiss button + CTA both ≥ 44×44 px (NFR-A2 — established in Story 2.1 for cards).
   - Pure presentation; props OPTIONAL — defaults to internal hook. For testability, accept an OPTIONAL `_useHook` injection prop guarded by `process.env.NODE_ENV === 'test'` is **NOT** the pattern — instead, the component test mocks `useMembers` via `QueryClientProvider` + a seeded query (mirror Story 2.4 / 2.5 test pattern). No injection prop.

6. **Mount on the dashboard placeholder.** Edit `src/app/routes/dashboard.tsx`:
   - Render `<CycleEndingAlert>` ABOVE the existing `<h1>Tableau de bord</h1>` heading. The existing placeholder body + "Mes membres" CTA stay (Story 9.1 will replace them; leave them intact).
   - **Layering:** the dashboard route imports from `@/features/cycle` — which already exports `CycleProgressBar`. Add `CycleEndingAlert` to the `src/features/cycle/index.ts` barrel.

7. **Member-list filter** for `?filter=cycles-ending`. Edit `src/features/member/ui/MemberList.tsx`:
   - Read the URL search params via `useSearchParams()` from `react-router-dom`.
   - When `searchParams.get("filter") === "cycles-ending"`, apply an additional filter step in `useFilteredMembers` (or a wrapping `useMemo` outside it) that keeps only members where `isCycleInUpcomingEndWindow(m.currentCycle?.dayNumber ?? -1, DEFAULT_CYCLE_ENDING_WINDOW_DAYS)`. If `currentCycle` is `null`, the member is excluded.
   - Render a **dismiss-this-filter chip** above the standard filter chips: a pill that reads `t("members.filter_cycles_ending_active")` (*"Cycles à clôturer (×)"*) — tapping it removes the URL param via `setSearchParams({})`. The existing `actif/avance/termine` chips continue to work in conjunction (so the collector can additionally filter by status if they want).
   - The chip is rendered ONLY when the URL param is set (zero visual change for the default `/members` route).
   - The standard chip filter logic remains unchanged.

8. **Per-session dismiss semantics.** **Given** the alert was dismissed in the current session, **When** the collector navigates back to `/dashboard` in the same browser session, **Then** the alert remains hidden. **When** the collector closes the tab/window and reopens the app, **Then** the alert reappears (sessionStorage clears on tab close). Use `sessionStorage`, NOT `localStorage` (BDD: *"reappears on next app load"*).

9. **Empty / zero-state behaviour.** **Given** no member's cycle is in the window, **When** the dashboard loads, **Then** the alert renders nothing (no "0 cycles ending" zero-state). The dashboard layout absorbs the absence cleanly (no reserved height — the alert is conditionally rendered).

10. **Loading-state behaviour.** **Given** `useMembers()` is in its first-load state (`isLoading === true`), **When** the dashboard renders, **Then** the alert renders nothing (no skeleton — same MVP convention as `MemberList`'s "no skeleton at MVP" choice from Story 2.1; the home surface flash-of-empty is acceptable per UX rationale).

11. **Tests — domain (vitest, 100 % coverage gate maintained).** Edit `src/domain/cycle/cycleEngine.test.ts`:
    - 4 example tests for `daysUntilCycleEnd`: day 1 → 29, day 15 → 15, day 30 → 0, day 31 (out-of-band, defensive) → 0 (clamp).
    - 4 example tests for `isCycleInUpcomingEndWindow`: (day 23, window 7) → true (7 remaining), (day 24, window 7) → true (6 remaining), (day 22, window 7) → false (8 remaining), (day 30, window 7) → true (0 remaining — inclusive boundary).
    - 1 fast-check property: ∀ day ∈ [1, 30], windowDays ∈ [0, 30]: `isCycleInUpcomingEndWindow(day, windowDays) === (CYCLE_TOTAL_DAYS - day <= windowDays)`. Validates the implementation against its specification.
    - The new `DEFAULT_CYCLE_ENDING_WINDOW_DAYS` constant is asserted in 1 test (`expect(DEFAULT_CYCLE_ENDING_WINDOW_DAYS).toBe(7)`).
    - Cycle module STILL 100 % coverage across statements / branches / functions / lines.

12. **Tests — selector (vitest, plain unit).** New `src/features/cycle/api/selectMembersWithCycleEndingSoon.test.ts`:
    - Empty input → `[]`.
    - All members `termine` → `[]`.
    - Mix of in-window / out-of-window / `currentCycle === null` / `displayStatus === 'termine'` → exactly the in-window non-`termine` rows, original order preserved.
    - Window 0 → only members at day 30.
    - Window 30 → all members with an active `currentCycle`.

13. **Tests — hook (vitest + RTL).** New `src/features/cycle/api/useCyclesEndingAlert.test.tsx`:
    - Wraps in `QueryClientProvider` with seeded `useMembers()` data (mirror Story 2.4 pattern).
    - Cases: count > 0 + not dismissed → `{ count: N, isDismissed: false }`; count > 0 + sessionStorage flag set on mount → `isDismissed: true`; `dismiss()` → flips `isDismissed` AND writes `sc_cycle_ending_alert_dismissed=1` to sessionStorage; `useMembers` loading → `isLoading: true`.
    - **Cleanup:** each test calls `sessionStorage.clear()` in `afterEach` (mirror the existing test hygiene from Story 2.5).

14. **Tests — component (vitest + RTL).** New `src/features/cycle/ui/CycleEndingAlert.test.tsx`:
    - Renders nothing when count is 0.
    - Renders nothing when dismissed.
    - Renders title + count-aware body + "Voir" link with `href="/members?filter=cycles-ending"` + dismiss button when count > 0.
    - Tapping dismiss → component disappears (re-render with `isDismissed=true`).
    - Tapping "Voir" → MemoryRouter receives the navigation (assert via `<MemoryRouter>` + screen.getByRole("link", { name: /voir/i }).getAttribute("href")`).
    - axe-clean (no violations). Use `jest-axe` (already in devDeps via Story 2.4).

15. **Tests — MemberList filter extension (vitest + RTL).** Extend `src/features/member/ui/MemberList.test.tsx`:
    - Render `MemberList` inside `MemoryRouter initialEntries={["/members?filter=cycles-ending"]}`.
    - Seed `useMembers` with a mix of in-window and out-of-window members.
    - Assert: only in-window rows appear; the dismiss-filter chip is visible.
    - Tap the dismiss-filter chip → URL param cleared → all members reappear.
    - The standard chip filters still work in combination (e.g., `actif` chip + URL filter intersect).

16. **Tests — E2E (Playwright).** New `tests/e2e/flow-3-cycles-ending-alert.spec.ts`:
    - Seed via service-role client: 3 members with active cycles; manipulate `cycles.start_date` so member A has `daysRemaining = 30 - 25 = 5` (in window), member B has `daysRemaining = 20` (out), member C has `daysRemaining = 0` (in, day-30 boundary). Member D status = `completed` (out — `displayStatus = termine`). Use the existing seed fixture pattern from Story 2.4 / 4.3.
    - Login → `/dashboard` → assert the alert renders with count `2` (A + C).
    - Tap "Voir" → `/members?filter=cycles-ending` → assert exactly members A and C are visible; B and D absent.
    - Tap the in-list dismiss-filter chip → URL strips `?filter=cycles-ending` → all 3 visible-status members (A, B, C) appear; D stays hidden because `displayStatus === 'termine'` is filtered out independently by the existing chip logic.
    - Navigate back to `/dashboard` → tap dismiss × → alert disappears → reload `/dashboard` → alert STILL hidden (sessionStorage persists across reload within the same context). Note: `page.reload()` keeps sessionStorage; closing/reopening the BrowserContext clears it, but Playwright's default per-test fresh context means each test starts with a clean session.
    - **Run locally before push** (Story 2.5 retrospective discipline; `npx playwright test`).

17. **i18n keys.** Add to `src/i18n/fr.json`:
    - `dashboard.cycles_ending.title` = `"Cycles se terminant cette semaine"`
    - `dashboard.cycles_ending.body_zero` = `"Aucun cycle dans la fenêtre"` (defensive — the component renders nothing at count 0, but the key is needed so the type-derived `TranslationKey` enum stays clean if a future change re-introduces the zero state)
    - `dashboard.cycles_ending.body_one` = `"1 membre — clôture imminente"`
    - `dashboard.cycles_ending.body_many` = `"{count} membres — clôture imminente"`
    - `dashboard.cycles_ending.cta` = `"Voir"`
    - `dashboard.cycles_ending.dismiss_aria` = `"Masquer cette alerte"`
    - `members.filter_cycles_ending_active` = `"Cycles à clôturer ×"` (active-filter chip; the trailing `×` is part of the literal so it reads as a self-explanatory dismissable pill — mirrors the inline `dialog_summary_zero` / `_one` / `_many` pluralisation pattern shipped by Story 2.6).
    - **Pluralisation rule:** the component picks `body_zero` / `body_one` / `body_many` via a tiny inline switch (`count === 0 ? "body_zero" : count === 1 ? "body_one" : "body_many"`). Mirrors `members.count_label_*` from Story 2.1 — same convention, no new dependency.

18. **No new dependencies.** All work is pure TS + existing TanStack Query / React Router / sessionStorage / Lucide / Tailwind. No new npm install.

19. **No new migrations / RPC / triggers.** This is an entirely client-side surface. The schema's `cycles.end_date` (migration 0001:111) and the existing PostgREST `cycles` reads in `useMembers` (Story 2.1) provide every byte of data needed. **Do NOT add a `useCycleList.ts` RPC** — the architecture file lists this as a future home (`architecture.md:931`) but Story 3.5 derives everything from the existing `useMembers()` cache.

20. **All gates green.**
    - `npm run typecheck` — no new TS errors. The 1 `useCyclesEndingAlert` hook + 1 selector + 1 component + dashboard mount + MemberList filter must all type-check under strict mode.
    - `npm run lint` — no new warnings. ESLint cross-feature import rule: dashboard imports from `@/features/cycle` (allowed via barrel); MemberList imports `isCycleInUpcomingEndWindow` from `@/domain/cycle` (allowed — domain has no import restrictions).
    - `npm test -- --coverage` — domain still 100 %; new files ≥ 80 %.
    - `npm run test:edge` — UNCHANGED (no new edge tests; Story 3.5 is purely client-side).
    - `npm run build` — bundle size budget unchanged within tolerance (the new component is < 1 kB gzipped — verifiable in CI bundle-size step).
    - `npx playwright test` — full suite green LOCALLY before push (Story 2.5 retro). 1 new spec.

## Tasks / Subtasks

- [x] **Task 0 — Domain primitives (AC #1 #2 #11).** Edit `src/domain/cycle/cycleEngine.ts` + `cycleEngine.test.ts` + `index.ts`:
  - Add `DEFAULT_CYCLE_ENDING_WINDOW_DAYS`, `daysUntilCycleEnd`, `isCycleInUpcomingEndWindow`.
  - Export from the barrel.
  - Add 4 + 4 example tests + 1 fast-check property + 1 default-constant assertion.
  - Confirm cycle module 100 % coverage maintained.

- [x] **Task 1 — Feature selector (AC #3 #12).** New `src/features/cycle/api/selectMembersWithCycleEndingSoon.ts` + `.test.ts`. Pure function; 5 unit-test cases. No new external deps.

- [x] **Task 2 — Hook (AC #4 #13).** New `src/features/cycle/api/useCyclesEndingAlert.ts` + `.test.tsx`. Wraps `useMembers` + selector + sessionStorage + local `useState` for re-render. 4 RTL test cases.

- [x] **Task 3 — Component (AC #5 #14).** New `src/features/cycle/ui/CycleEndingAlert.tsx` + `.test.tsx`. Banner + Lucide `X` button + axe-clean. Use semantic Tailwind tokens (NO hard-coded hex). 5 RTL test cases.

- [x] **Task 4 — Barrel update (AC #6).** Edit `src/features/cycle/index.ts` to export `CycleEndingAlert` + its props type.

- [x] **Task 5 — Dashboard mount (AC #6).** Edit `src/app/routes/dashboard.tsx` to render `<CycleEndingAlert />` above the existing heading. Keep the existing placeholder body intact (Story 9.1 will rework).

- [x] **Task 6 — Member-list filter (AC #7 #15).** Edit `src/features/member/ui/MemberList.tsx`:
  - Add `useSearchParams` integration.
  - Extend `useFilteredMembers` (or wrap with a second `useMemo`) to apply the cycles-ending filter.
  - Render the dismiss-filter chip when the URL param is active.
  - Wire the `setSearchParams({})` clear.
  - Extend `MemberList.test.tsx` with the 3 cases per AC #15.

- [x] **Task 7 — i18n keys (AC #17).** Add the 7 keys to `src/i18n/fr.json`. The TypeScript `TranslationKey` derivation will pick them up automatically.

- [x] **Task 8 — E2E (AC #16).** New `tests/e2e/flow-3-cycles-ending-alert.spec.ts`. Mirror the seed pattern from `flow-1-record-contribution.spec.ts` (Story 4.3) for service-role data setup. **Run locally** before push.

- [x] **Task 9 — All gates (AC #20).** `npm run typecheck` / `lint` / `test -- --coverage` / `build` / **`npx playwright test` LOCALLY**.

- [x] **Task 10 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log entry.
  - `sprint-status.yaml`: `3-5-cycles-ending-alerts: backlog → ready-for-dev` (this skill does it on save) → after dev: `→ review`.
  - Add a one-liner in Story 9.2's eventual Dev Notes (when 9.2 is created) that 3.5 ships the canonical alert UI; 9.2's scope reduces to layout integration when Story 9.1 lands.

### Review Findings

Code review run 2026-04-26 via `/bmad-code-review` (3 parallel adversarial layers — Blind Hunter, Edge Case Hunter, Acceptance Auditor — Sonnet model). 17 raw findings → 8 patches + 2 deferred + 7 dismissed.

- [x] **[Review][Patch] `setSearchParams({})` wipes ALL URL query params, not just `filter`** [src/features/member/ui/MemberList.tsx:170] — when a future story adds a second URL param (sort, search), the dismiss-filter chip silently nukes them. Fix: delete only the `filter` key and preserve the rest. Source: blind+edge.
- [x] **[Review][Patch] E2E `Date.now()`-derived `start_date` flakes near UTC-midnight / DST boundaries** [tests/e2e/flow-3-cycles-ending-alert.spec.ts:33-35] — wall-clock millisecond arithmetic with `MS_PER_DAY = 86_400_000` shifts the computed `dayNumber` by ±1 when the test runs near midnight or across a DST transition. Fix: floor to UTC date or compute via `Date.UTC` arithmetic. Source: blind+edge.
- [x] **[Review][Patch] Missing i18n key `dashboard.cycles_ending.body_zero`** [src/i18n/fr.json] — AC #17 explicitly lists 7 keys; only 6 landed. Defensive zero-state key keeps the type-derived `TranslationKey` enum clean if a future change re-introduces the zero state. Source: auditor (AC #17).
- [x] **[Review][Patch] Hook test bypasses `QueryClientProvider` via module-level `vi.mock`** [src/features/cycle/api/useCyclesEndingAlert.test.tsx] — AC #13 requires "Wraps in `QueryClientProvider` with seeded `useMembers()` data (mirror Story 2.4 pattern)". Current test stubs the hook entirely, never exercising the cache path. Fix: rewrite using `QueryClientProvider` + `setQueryData(MEMBERS_QUERY_KEY, ...)`. Source: auditor (AC #13).
- [x] **[Review][Patch] `aria-label` on dismiss-filter chip + visible × glyph + Lucide `<X />` icon = double-symbol render + screen reader reads "multiplié"** [src/i18n/fr.json + src/features/member/ui/MemberList.tsx:169-176] — `aria-label={t("members.filter_cycles_ending_active")}` resolves to `"Cycles à clôturer ×"`; SR announces "Cycles à clôturer multiplié"; visually two × glyphs render. Fix: drop the literal × from the i18n value (keep `"Cycles à clôturer"`); set `aria-label` via a separate key like `"Retirer le filtre cycles à clôturer"`; keep the Lucide icon as the visual close. Source: blind+edge.
- [x] **[Review][Patch] `aria-live="polite"` live-region timing — section unmounts on dismiss/load + injects fresh on first render** [src/features/cycle/ui/CycleEndingAlert.tsx:33-43] — (a) NVDA/JAWS may not announce a freshly-injected live region; (b) some readers announce removal as noise. Fix: keep the `<section role="status" aria-live="polite">` mounted at all times, conditionally render its CONTENTS instead. Source: blind+edge.
- [x] **[Review][Patch] `dismiss` callback recreated on every render (no `useCallback`)** [src/features/cycle/api/useCyclesEndingAlert.ts:42-47] — latent stale-reference trap if a future consumer wraps the alert in `React.memo`. Fix: wrap in `useCallback` with empty deps. Source: blind+edge.
- [x] **[Review][Patch] Component test "tap dismiss → component disappears" is incomplete** [src/features/cycle/ui/CycleEndingAlert.test.tsx] — AC #14 requires asserting the banner unmounts after dismiss; current test only verifies the callback fires. Fix: re-render with `isDismissed: true` after the click and assert `container.firstChild === null`. Source: auditor (AC #14).
- [x] **[Review][Defer] No test for `useMembers` returning `isError: true`** [src/features/cycle/api/useCyclesEndingAlert.ts] — deferred, pre-existing dashboard-error pattern (placeholder dashboard doesn't surface error states; Story 9.1 will when it ships the real layout). Tracked in deferred-work.md.
- [x] **[Review][Defer] Tailwind warning-palette token mismatch (`warning-50/200/800/900` not in config)** [src/features/cycle/ui/CycleEndingAlert.tsx + cross-cutting] — deferred, pre-existing palette-token drift across `MemberActionSheet`, `ProgressiveToast`, etc. Story 3.5 followed the existing convention. Tracked in deferred-work.md.

**Dismissed (7) — not actionable:**

- Selector race (cycle status flip vs view-model lag) — handled by `pickCurrentCycle`'s null-return for completed cycles + selector's null-guard.
- URL filter casing not normalised — app-controlled URLs only.
- `daysUntilCycleEnd(0)` clamp below — input domain [1, 30] enforced upstream by `computeCycleDay`'s clamp.
- `bodyKey` no negative guard — `count` is `members.length`, always ≥ 0; `count === 0 → return null` guard fires upstream.
- Selector evaluation ordering of null vs termine checks — both produce the same result; data-model invariant (termine ⇒ no active cycle) makes the order moot.
- Dismiss-filter chip keyboard tab order — DOM order matches semantic order; "actually fine" per Edge Hunter's own analysis.
- Hook test mocks internal path not barrel — matches the production import path (intentional; documented in Dev Notes).

## Dev Notes

### Architecture compliance

- **Layering.** Pure scalars in `src/domain/cycle/` → feature-level selector + hook + component in `src/features/cycle/{api,ui}/` → mount on `src/app/routes/dashboard.tsx`. No `infrastructure/` or `supabase/` changes. Cross-feature import (dashboard route reading from `@/features/cycle`) goes through the cycle feature's `index.ts` barrel — ESLint cross-feature rule respected.
- **No new dependencies.** TanStack Query, React Router v7, Lucide, Tailwind, sessionStorage are all already in the bundle.
- **No new RTT.** The selector derives everything from `useMembers()` (Story 2.1's existing cache; `staleTime: 30_000`). The dashboard route already renders behind `ProtectedRoute`, so the session is established before the alert mounts.
- **Tokens, not hex (CLAUDE.md anti-pattern).** Use Tailwind warning-palette tokens (`bg-warning-50`, `text-warning-900`, etc.) — grep the Tailwind config first to find the exact names. The UX spec colours (`#FAEEDA`, `#633806`, `#854F0B` — line 509) ARE the source of truth, but they MUST be applied via the configured tokens, NOT inlined.
- **Cite sources.** Every implementation file should carry a 1-line header comment citing the FR + Story (e.g., `// Story 3.5 / FR20 — cycles-ending alert`).

### Why the selector lives in `features/cycle/api/` (not `domain/`)

The pure boolean primitive (`isCycleInUpcomingEndWindow`) IS in `domain/cycle/` because it's a scalar-in / scalar-out cycle-math fact. The selector that takes a `MemberWithMeta[]` is feature-level because `MemberWithMeta` is a view-model defined in `src/features/member/types.ts`, not a domain entity — and the layering rule is `domain/` imports nothing from `features/`. Putting the selector in `domain/` would require either (a) duplicating the type or (b) inverting the layering — both worse than putting the selector at the feature boundary where the view-model already lives.

### Why per-session dismiss is sessionStorage, not React state

If the dismiss state were React state, navigating Dashboard → Members → Dashboard would re-show the alert (the dashboard component re-mounts). The BDD requires the dismiss to persist across the dashboard's mount/unmount within a session — sessionStorage is the lightest mechanism that achieves that. localStorage would persist across browser restarts, which contradicts BDD line 786 (*"reappears on next app load"*).

### Why no separate cycles RPC / `useCycleList`

The architecture file (`architecture.md:931`) lists `src/features/cycle/api/useCycleList.ts` as a future hook, but Story 3.5 has zero need for it. `useMembers()` already returns each member's `currentCycle.dayNumber` (computed via `computeCycleDay` from Story 2.1). Going through a separate cycles RPC would (a) add an RTT, (b) duplicate the day-derivation, (c) require its own RLS contract test. **Defer `useCycleList` to a story that actually needs it** (most likely Story 7.1 / 7.3 settlement). YAGNI.

### Why the URL search param for the member-list filter

- **Shareability.** A collector can copy the URL and revisit the filtered list (relevant once the dashboard alert is in their muscle memory).
- **Reload-resilience.** Per-session-dismiss applies to the alert; the FILTER itself (when active) survives reload because it's in the URL.
- **No new state-machine.** React Router's `useSearchParams` is already in the toolbox; React Context for cross-component filter state would be overkill for one chip.
- **Composable with chip filters.** `?filter=cycles-ending` AND `actif` chip can be active simultaneously — the BDD does not exclude this combination; it's natural and useful.

### Why we INCLUDE day-30 (`daysRemaining = 0`) in the window

A cycle at day 30 IS still active until the status trigger flips it to `completed` (Story 3.3 + Story 7.x will close that loop). The collector SHOULD see day-30 members in the alert because they are the most urgent — they're "settle today". The boundary `daysRemaining <= windowDays` (inclusive) captures this naturally. Excluding `daysRemaining = 0` would create a one-day blind spot at the most critical moment of the cycle, which is the opposite of FR20's intent.

### Story-9.2 handshake

Story 9.2 (Epic 9) BDD reads:

> **Given** at least one member with cycle ending in the configured upcoming window (default 7 days),
> **When** the dashboard renders,
> **Then** an alert banner displays with the count and a CTA "Voir",
> **When** the collector taps "Voir",
> **Then** the member list opens filtered to the cycles-ending members,
> **When** the collector taps "×" on the alert,
> **Then** the alert is dismissed for the current session (reappears on next app open).

This is **functionally identical** to Story 3.5's BDD. Story 3.5 ships the canonical UI + behaviour. When Story 9.2 is created, its scope reduces to:

1. Re-mount `<CycleEndingAlert>` in Story 9.1's full dashboard layout (alongside StatsTriple + RecentActivity + etc.).
2. Confirm the alert lands in the correct position relative to the new layout grid.

That's it — the component, hook, selector, filter, dismiss, i18n, tests, and E2E are all owned by Story 3.5. Document this in Story 9.2's eventual Dev Notes when 9.2 is created (not by 3.5 — 9.2 doesn't exist yet).

### Anti-patterns (do NOT do)

- **Do NOT** add a new TanStack Query key for `useCyclesEndingAlert`. It's a derivation of `useMembers()`, not a fetch.
- **Do NOT** call `useMembers()` inside the dashboard route AND inside the alert hook — the cache de-dupes them, but the cleaner pattern is: the alert hook owns the read, the dashboard route owns the layout.
- **Do NOT** use `localStorage` for the dismiss flag — the BDD specifies *"reappears on next app load"* which is a session-scope, not a forever-scope. localStorage would silently break this.
- **Do NOT** hard-code colours. UX spec line 509 specifies the warning palette; apply via Tailwind tokens.
- **Do NOT** add a "0 cycles ending" zero-state to the dashboard. The component renders nothing at count 0 by design.
- **Do NOT** introduce a `?filter=cycles_ending` (snake_case) URL param. The repo's URL-param convention is kebab-case (`/members?filter=cycles-ending`) — same pattern PostgREST queries don't dictate URL-search-param case; choose what reads best from a French-first user's perspective. Kebab-case wins.
- **Do NOT** wire the alert to refresh on a 60-s polling interval at MVP. Story 9.1 will introduce the dashboard's 60-s poll (FR34); Story 3.5 inherits the existing `useMembers()` `staleTime: 30_000` and that's sufficient. Adding a poll here would be premature and would conflict with Story 9.1's later refresh-orchestration.
- **Do NOT** put the alert on `/members`. The BDD says **dashboard** explicitly. The collector who is already on `/members` is already in the position to act; the alert is a home-surface affordance.
- **Do NOT** add an `isCycleEndingForMember(member: MemberWithMeta)` helper to `domain/cycle/`. The domain layer cannot import `MemberWithMeta` (layering rule).

### Edge cases worth testing (covered by Tasks 1 + 2 + 6 + 8)

- **Member with `currentCycle === null`.** Selector skips them. Hook count excludes them. Component still works.
- **Member with `displayStatus === 'termine'`.** Selector skips them. The list filter on `/members?filter=cycles-ending` also skips them (the filter applies AFTER the existing chip filters wouldn't normally show `termine` rows; the cycles-ending filter is composed with the standard `displayStatus !== 'hidden'` precondition).
- **All members have `displayStatus === 'termine'`.** Count is 0. Alert renders nothing (AC #9).
- **Window 0.** Only members at day 30 match.
- **Window 30.** Every active member matches — the alert effectively becomes "you have N active cycles". The default is 7, so this case is purely exercise-defensive; no UX impact.
- **Dismiss persists across `/dashboard` re-mount within a session.** sessionStorage handles this trivially.
- **Dismiss does NOT persist across browser tab close.** sessionStorage is scoped to the tab; new tab → fresh session → alert reappears.
- **Filter chip + URL filter compose.** Standard chip `actif` + URL param `cycles-ending` = active members at day ≥ 23. Both filters apply via `&&`.
- **Reload while filter is active.** URL persists → filtered view persists. ✓
- **Concurrency: useMembers refetch.** When the cache invalidates (e.g., after a contribution from Story 4.3), `selectMembersWithCycleEndingSoon` re-runs naturally on the next render. No manual invalidation needed.

### Definition-of-done checklist

- All 20 ACs satisfied + all 11 tasks ticked.
- No new migrations / RPC / Edge Function (Story 3.5 is client-only).
- 7 new i18n keys land in `fr.json`.
- New domain primitives covered by 9 new tests + 1 fast-check property; cycle module STILL 100 % coverage.
- New selector + hook + component + filter wiring covered by 5 + 4 + 5 + 3 RTL/vitest tests respectively.
- 1 new Playwright spec passes locally (`npx playwright test`).
- `npm run typecheck` / `lint` / `test --coverage` / `build` all green.
- Story status set to `review`; sprint-status updated.
- Story file's Dev Notes captures the Story-9.2 handshake (so the future Story 9.2 author doesn't redo work).

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 773-786 (Story 3.5 BDD).
- **Sibling story (overlapping scope):** `_bmad-output/planning-artifacts/epics.md` lines 1286-1300 (Story 9.2 BDD — same surface, different epic; Story 3.5 ships canonical UI).
- **PRD:**
  - `_bmad-output/planning-artifacts/prd.md` line 500 (FR20 — cycles ending in upcoming window).
  - `_bmad-output/planning-artifacts/prd.md` line 525 (FR35 — dashboard alerts dismissable).
  - `_bmad-output/planning-artifacts/prd-validation-report-2026-04-18.md:445` (window default — *"deliberate flexibility"*).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md:937` (`CycleEndingAlert.tsx` slot in `src/features/cycle/ui/`).
  - `_bmad-output/planning-artifacts/architecture.md:1086` (FR15-21 home: `src/domain/cycle/`, `src/features/cycle/`).
  - `_bmad-output/planning-artifacts/architecture.md:1112` (Flow 3 settlement entry: dashboard alert → filtered member list).
- **UX spec:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md:509` (warning / attention semantic palette — `#FAEEDA` / `#633806` / `#854F0B`).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:799` (Flow 3 mermaid: dashboard alert → "Prêt pour clôture" filtered list).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:927` (entry-point convergence pattern: multiple paths into a single screen).
- **Schema:**
  - `supabase/migrations/20260419000001_init_schema.sql:106-118` (cycles table; `start_date`, `end_date`, `status`).
- **Companion stories already shipped:**
  - Story 2.1 — `useMembers()` (the upstream cache); `MemberList.tsx` (the filter target); `computeCycleDay` (the day derivation).
  - Story 3.2 — pure cycle engine (where the new primitives land); `CYCLE_TOTAL_DAYS = 30` constant.
  - Story 3.3 / 3.4 — server-side status enforcement (the alert is the *client-side* counterpart for FR20).
  - Story 4.3 — service-role seed pattern for E2E (mirror for Task 8's spec).
- **Process discipline:**
  - Run Playwright LOCALLY before each push (Story 2.5 retrospective).
  - CLAUDE.md § Operating principles (tokens not hex; layering enforced by ESLint; Zod at boundaries).
  - CLAUDE.md § Local-DB workflow (no `db:reset` for daily dev — but Story 3.5 has no migrations).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] via `bmad-dev-story` skill (Claude Code).

### Debug Log References

- **i18n key resolution gating component test.** First component test run failed because `t()` returned the raw key string when the `dashboard.cycles_ending.*` keys weren't yet in `fr.json` — text matchers like `screen.getByText(/Cycles se terminant/)` couldn't resolve. Fix: jumped to Task 7 to land the i18n keys before re-running Task 3's tests. Order updated in this note for Story 9.2's author: ship i18n keys BEFORE component tests, not after.
- **`Pick<MemberWithMeta, "id" | "name">` + spread overwrite (TS2783).** First typecheck pass flagged `id` and `name` set explicitly before `...override` in the test fixture factories — the spread overwrites them, so the explicit keys are dead. Fix: removed the leading explicit keys; the spread now provides them.
- **Cross-feature `import/no-internal-modules` rule.** First lint pass rejected `import type { MemberWithMeta } from "@/features/member/types"` from `features/cycle/`. Fix: route through the barrel `@/features/member`. The intra-feature `import { useMembers } from "@/features/member/api/useMembers"` inside `useCyclesEndingAlert.ts` was NOT flagged — confirmed allowed by the existing rule config. Re-routing it through the barrel would create a circular dependency (the barrel re-exports from `api/`).

### Completion Notes List

- All 20 ACs satisfied. 10 tasks completed.
- 3 new domain primitives (`DEFAULT_CYCLE_ENDING_WINDOW_DAYS`, `daysUntilCycleEnd`, `isCycleInUpcomingEndWindow`) + 9 example tests + 1 fast-check property landed in `cycleEngine.ts`. Cycle module coverage stays at 100 %.
- Pure feature selector + 5 unit tests in `features/cycle/api/`.
- `useCyclesEndingAlert` hook with sessionStorage-backed dismiss + 4 RTL tests. Hook coverage at 92.3% statements / 100% functions / 100% lines (the 2 uncovered branches are defensive `typeof sessionStorage === "undefined"` guards for SSR — unreachable in a Vite SPA).
- `<CycleEndingAlert>` component using the warning palette (`bg-warning-50 border-warning-200 text-warning-800`) + Lucide `X` button + 7 RTL tests including jest-axe. Component coverage at 100 %.
- Dashboard mount (`src/app/routes/dashboard.tsx`) renders the alert above the existing heading; placeholder body left intact for Story 9.1's eventual rewrite.
- `MemberList.tsx` extended with `useSearchParams`-driven cycles-ending filter, composable with the existing chip filters via AND, plus a dismiss-filter pill that clears the URL param. 3 new tests pass (filter active / chip dismiss / compose with status chip).
- 7 new i18n keys under `dashboard.cycles_ending.*` + `members.filter_cycles_ending_active`.
- New Playwright spec `flow-3-cycles-ending-alert.spec.ts` seeds 4 members with mixed cycle-ending positions, asserts alert count = 2, tap "Voir" filters the list, dismiss-filter chip clears the URL, dismiss × hides the alert, reload preserves the dismissed state. Spec validated locally with the full Supabase stack: 20 passed, 1 skipped (rate-limit, expected).
- All gates green: typecheck ✅ / lint ✅ / 475 vitest passing (1 skipped) ✅ / coverage 84.36/75.69/87.33/88.12 (all above 80/75/80/80) ✅ / build ✅ / Playwright ✅.
- Story 9.2 handshake documented in Dev Notes — 9.2's scope reduces to mounting the existing component in Story 9.1's full dashboard layout when that lands.

### File List

**New (6 files):**
- `src/features/cycle/api/selectMembersWithCycleEndingSoon.ts`
- `src/features/cycle/api/selectMembersWithCycleEndingSoon.test.ts`
- `src/features/cycle/api/useCyclesEndingAlert.ts`
- `src/features/cycle/api/useCyclesEndingAlert.test.tsx`
- `src/features/cycle/ui/CycleEndingAlert.tsx`
- `src/features/cycle/ui/CycleEndingAlert.test.tsx`
- `tests/e2e/flow-3-cycles-ending-alert.spec.ts`

**Modified (7 files):**
- `src/domain/cycle/cycleEngine.ts` (added 3 primitives + the constant)
- `src/domain/cycle/cycleEngine.test.ts` (10 new tests including 1 fast-check property)
- `src/domain/cycle/index.ts` (barrel export of the new symbols)
- `src/features/cycle/index.ts` (barrel export of the alert component + hook + selector)
- `src/app/routes/dashboard.tsx` (mounted `<CycleEndingAlert>` above the heading)
- `src/features/member/ui/MemberList.tsx` (URL filter + dismiss-filter chip + import of the new domain helpers)
- `src/features/member/ui/MemberList.test.tsx` (3 new test cases for the URL filter)
- `src/i18n/fr.json` (7 new keys: `dashboard.cycles_ending.{title,body_one,body_many,cta,dismiss_aria}` + `members.filter_cycles_ending_active`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip ready-for-dev → in-progress → review)
- `_bmad-output/implementation-artifacts/3-5-cycles-ending-alerts.md` (this file — Tasks ✓, Completion Notes, File List, Change Log, Status → review)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-26 | Winston (architect) | Story 3.5 spec generated by `bmad-create-story`. Closes Epic 3 with the client-side surface for FR20: pure domain primitives (`daysUntilCycleEnd`, `isCycleInUpcomingEndWindow`, `DEFAULT_CYCLE_ENDING_WINDOW_DAYS = 7`) → feature selector + `useCyclesEndingAlert` hook (derives from existing `useMembers()` cache; no new RTT) → `<CycleEndingAlert>` warning-palette banner mounted on the dashboard placeholder → tap "Voir" navigates to `/members?filter=cycles-ending` (new URL-driven filter + dismiss-filter chip) → per-session dismiss via sessionStorage. Zero migrations, zero new dependencies, zero new RPC. Story 9.2 (Epic 9) overlaps verbatim — 3.5 ships canonical UI; 9.2's scope reduces to layout integration once Story 9.1's full dashboard lands. Status → ready-for-dev. |
| 2026-04-26 | dev agent (Opus 4.7 via `bmad-dev-story`) | Implementation complete. 6 new files + 7 modified. 10 new vitest cases for the domain primitives (incl. 1 fast-check property), 5 selector tests, 4 hook tests, 7 component tests (jest-axe clean), 3 MemberList integration tests. Cycle module coverage stays at 100 %; new component file at 100 %; new hook at 92.3 % statements (2 defensive `typeof sessionStorage` SSR guards uncovered, unreachable in Vite SPA). All gates green: typecheck / lint / 475 vitest / coverage 84.36/75.69/87.33/88.12 / build / 20-passing-1-skipped Playwright validated locally with the full Supabase stack. Status → review. |
