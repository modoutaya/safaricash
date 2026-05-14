# Story 7.3: Settlement initiation and computation

Status: review

## Story

As a **collector**,
I want **to initiate settlement from the member profile and see the computed final payout**,
so that **I can confidently close a cycle knowing the exact amount (FR21).**

> **Predicate of this story.** Epic 7's third deliverable — the **route + wiring layer** that brings Story 7.1's `SettlementSummaryCard` to life with real cycle data. Story 7.3 ships:
> 1. A new **`/members/:id/settlement` route** that loads the member + current cycle + transactions, computes the advances array, and mounts `SettlementSummaryCard` (Story 7.1).
> 2. The **"Clôturer le cycle" entry-point CTA** in the member profile header — visible iff `currentCycle.status === "completed"`.
> 3. A **stub for the Confirm CTA** that Story 7.4 will replace with the password re-auth dialog + `cycle-settlement` Edge Function commit.
>
> **What Story 7.3 does NOT ship:**
> - The re-auth flow gate (Story 7.4 — `re-auth` with `operation_intent: "cycle_settlement"`).
> - The settlement commit RPC / Edge Function (Story 7.4).
> - The `cycle.status === settled` transition (Story 7.4).
> - The final SMS dispatch (Story 7.5 — Story 6.3 template is already in place).
> - The post-commit `EnvelopeHandoverScreen` mount (Story 7.4 wires it after the RPC succeeds; Story 7.2 already ships the component).
> - The alternate entry path from the dashboard alert (UX flow line 799 `OR Member list filtered to 'Prêt pour clôture'`). The MVP entry-point is the member-profile CTA only; the dashboard-alert side path is deferred. The existing Story 3.5 `CycleEndingAlert` continues to point at `/members?filter=cycles-ending` (upcoming-end, not completed) — out of scope.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1129-1133`; the rest are spec-derived constraints required for a flawless implementation.

1. **Entry-point CTA — visibility gate.** **Given** a member viewed via `/members/:id`, **When** `currentCycle.status === "completed"`, **Then** a *"Clôturer le cycle"* button appears in the profile header (between *"Modifier"* and *"Supprimer"*, in the existing `role="group" aria-label={t("members.profile.actions_label")}` container). **When** `currentCycle.status === "active" | "with_advance"`, **Then** the button is NOT rendered (hidden, not disabled — matches the Story 2.7 *"Redémarrer le cycle"* pattern). **When** `currentCycle.status === "settled"`, **Then** the button is NOT rendered (already-settled cycles aren't re-settable).

2. **Entry-point CTA — navigation.** **Given** the *"Clôturer le cycle"* button is visible, **When** the collector taps it, **Then** the app navigates to `/members/:id/settlement` (same in-app routing as Stories 2.5 / 5.2 sub-routes).

3. **New route registration.** Register `/members/:id/settlement` in `src/app/router.tsx` after the `/members/:id/advance` entry (line ~57). Element: a new default export from `src/app/routes/members/[id].settlement.tsx`. **Lazy-loaded? No** — Story 5.2 / 5.4 didn't lazy-load either; consistency wins. The component is small (≈100 LOC) and bundling cost is negligible.

4. **Route file structure.** New `src/app/routes/members/[id].settlement.tsx`:
   - 1-line header comment citing BDD `epics.md:1129-1133` + FR21 + NFR-R3 + Stories 7.1 (card consumer) / 7.4 (commit owner) / 7.5 (final SMS).
   - Default export `MemberSettlementRoute`.
   - UUID regex guard (same `UUID_REGEX` as `[id].advance.tsx:24`) → `<Navigate to="/members" replace />` if param is malformed.
   - Inner `SettlementRouteBody` component takes `memberId: string`, calls `useMemberProfile(memberId)`.

5. **UUID guard.** Mirror the `[id].advance.tsx` pattern (lines 24-33). Param-level guard before any data fetch.

6. **Cycle precondition guard.** The route MUST defend the precondition `currentCycle.status === "completed"`. After the profile query resolves:
   - **`isLoading`** → render a profile-style skeleton (reuse `ProfileSkeleton` from `MemberProfileStates`).
   - **`isError`** → render `ProfileError` + back link.
   - **`data === undefined` OR `data.currentCycle === null`** → `<Navigate to="/members/${memberId}" replace />` (no cycle to settle).
   - **`data.currentCycle.status !== "completed"`** → `<Navigate to="/members/${memberId}" replace />` (precondition not met; e.g., user deep-linked to settlement of a still-active cycle, or refreshed after a settled cycle was already closed). This is the route-level enforcement of the BDD's "given" clause.

7. **Data plumbing.** From `useMemberProfile(memberId).data`, the route derives the `SettlementSummaryCardProps`:
   - `memberId` ← prop `memberId` (route param).
   - `memberName` ← `data.member.name`.
   - `dailyAmount` ← `data.member.daily_amount`.
   - `contributedTotal` ← `data.stats.contributedTotal` (already computed by Story 3.2's `computeMemberStats` over the current-cycle transaction subset — reuse it).
   - `advances` ← `data.transactions.filter((tx) => tx.kind === "advance").sort(NEWEST_FIRST).map((tx) => tx.amount)`. The sort comparator: `(a, b) => a.created_at < b.created_at ? 1 : -1` (matches `MemberProfile.tsx:64-66` newest-first convention). UX spec line 1107 says "newest first" for the sub-list — the caller (this route) owns the ordering per Story 7.1 AC #1.3.
   - `cycleId` ← `data.currentCycle.id`.
   - `cycleStartDate` ← `data.currentCycle.start_date`.
   - `cycleEndDate` ← `data.currentCycle.end_date`.
   - `onVerifyTransactions` ← see AC #9.
   - `onConfirm` ← see AC #10.
   - `isSubmitting` ← `false` for Story 7.3; Story 7.4 will replace the route to drive this from the re-auth/commit mutation state.

8. **NFR-R3 zero-tolerance compliance.** The final payout that `SettlementSummaryCard` renders MUST equal `settle(dailyAmount, advances)` from `@/domain/cycle` (Story 3.2). Story 7.1's component already enforces this internally — Story 7.3 only has to feed it the correct `dailyAmount` and `advances` array. **Sanity invariant for tests:** `settle(dailyAmount, advances) === stats.projectedFinalBalance` MUST hold for a completed cycle with no post-settlement-initiation writes. The route is NOT responsible for blocking late writes — that's the cycle's `status === "completed"` server-side gate (Story 3.3 trigger + `isCycleClosedForTransactions` predicate).

9. **`onVerifyTransactions` handler.** Per UX Flow 3 (lines 803-807), tapping *"Vérifier les transactions"* opens a transaction-list review that returns to the settlement card. **MVP implementation:** navigate to `/members/${memberId}` (the profile already lists the current-cycle transactions in newest-first order, exactly what the BDD demands for verification). The collector then taps *"Clôturer le cycle"* again to return to the settlement preview. **Why not a dedicated drill-down sub-route?** Two reasons: (a) the profile already renders the transaction list — no new UI surface needed; (b) keeps Story 7.3 small. **Future enhancement candidate**, NOT in this story: a `/members/:id/settlement/verify` sub-route with an explicit "Back to settlement" affordance. Document this in dev notes.

10. **`onConfirm` handler — Story 7.4 stub.** **MVP:** the route emits a `toast.info(t("settlement.flow.confirm_pending_toast"))` and stays on the settlement page (no navigation). Story 7.4 will REPLACE this handler with the password re-auth dialog + commit RPC. **DO NOT** wire a placeholder navigation that would lose the user's place. **DO NOT** disable the button (the card's `isSubmitting` is the only disable lever and it shows the wrong "Clôture en cours…" label). The toast is the cleanest dev-state UX. Document the stub clearly in a code comment so Story 7.4's dev finds it instantly.

11. **Route header.** Above the `SettlementSummaryCard`, render a minimal route header with:
    - Back chevron button → `navigate("/members/${memberId}")` (NOT `/members` — back to the profile, not the list).
    - An `<h1 className="text-title-1 text-text-primary">` with the page title: `t("settlement.flow.title")` = *"Clôture du cycle"*. Story 7.1 AC #9 explicitly leaves the `<h1>` to the route; the card emits an `<h2>` for the member name.
    - Match the spacing of `[id].edit.tsx` / `[id].advance.tsx` — same `mx-auto max-w-md p-4` outer container.

12. **i18n keys.** Add to `src/i18n/fr.json`:
    - `members.profile.action_settle`: *"Clôturer le cycle"* — header CTA on the member profile (AC #1).
    - `settlement.flow.title`: *"Clôture du cycle"* — route h1 (AC #11).
    - `settlement.flow.back_label`: *"Retour au profil"* — back chevron `aria-label` (AC #11).
    - `settlement.flow.confirm_pending_toast`: *"La confirmation sera disponible avec la prochaine mise à jour."* — Story 7.4 stub toast (AC #10).
    - 4 new keys. The first sits under the existing `members.profile.*` namespace; the other 3 add a new sub-namespace `settlement.flow.*` (parallel to Story 7.1's `settlement.summary.*` and Story 7.2's `envelope_handover.*`).

13. **Pure data computation — no domain primitives reinvented.** The route MUST NOT inline the `dailyAmount × 29 − Σ(advances)` formula. It MUST NOT inline the *"contributions + rattrapages"* sum (`computeMemberStats` already does it). It MUST NOT inline the kind-filter (use `.filter((tx) => tx.kind === "advance")` — `TransactionKind` enum is already exhaustive).

14. **No new dependencies, migrations, Edge Functions, or domain changes.** Story 7.3 is purely route + wiring. The data-fetching hook (`useMemberProfile`), the math (`settle`, `commission`), the component (`SettlementSummaryCard`), the i18n hook (`useT`), and the routing primitives are all in place.

15. **`MemberProfile` route — header CTA wiring.** In `src/app/routes/members/[id].tsx`:
    - Compute `canSettle = currentCycleStatus === "completed"` (mirror the existing `canRestart` / `canResendHistory` pattern at lines 56 / 61).
    - Render the *"Clôturer le cycle"* `<Button variant="outline" size="sm" asChild>` with `<Link to={`/members/${id}/settlement`}>` inside the existing `actions_label` group, BEFORE the destructive *"Supprimer"* button.
    - The `Restart cycle` and `Settle cycle` CTAs are MUTUALLY EXCLUSIVE on status: `canRestart` triggers on `completed | settled`; `canSettle` triggers on `completed` only. **Conflict:** both visible when status === `completed`. **Resolution:** both ARE visible — the UX intentionally allows the collector to either restart (skip settlement, re-open a new cycle) or settle (close out). The order in the header is: Modifier, Redémarrer (Story 2.7), Clôturer (this story), Renvoyer historique (6.6), Supprimer.

16. **Tests — route smoke + precondition + CTA wiring (vitest + RTL).** New `src/app/routes/members/[id].settlement.test.tsx`. Cases (≥ 8):
    - **Happy path: completed cycle renders `SettlementSummaryCard` with the correct props.** Mock `useMemberProfile` returns a `completed` cycle + transactions with 2 advances. Assert the card's headline (member name as `<h2>`) renders, the cycle date range renders, the row labels render, the final payout matches `settle(daily, [adv1, adv2])`.
    - **Precondition guard — cycle status `active` → redirect to profile.** Mock `useMemberProfile` returns `currentCycle.status === "active"`. Assert the route's `MemoryRouter` redirects to `/members/${id}` (assert via a sentinel route element).
    - **Precondition guard — cycle status `settled` → redirect to profile.** Mock `settled`. Same redirect assertion.
    - **Precondition guard — `currentCycle === null` → redirect to profile.**
    - **UUID guard — invalid id → redirect to `/members`.**
    - **Loading state — `isLoading=true` → skeleton renders.**
    - **Error state — `isError=true` → error UI + back link.**
    - **`onConfirm` stub fires `toast.info` once.** Mock `sonner` and click the "Confirmer et clôturer" button — assert `toast.info` was called with the stub copy.
    - **Advance ordering — newest-first.** Mock 3 advances with distinct `created_at`. Assert the sub-list renders them in newest-first order (regex match on the rendered `Avance 1 : ...`, `Avance 2 : ...`).
    - **`onVerifyTransactions` navigates to the profile.** Click the secondary CTA, assert the navigation lands on `/members/${id}`.

17. **Tests — MemberProfile header CTA (vitest + RTL).** EXTEND `src/app/routes/members/[id].test.tsx`:
    - Add a case: `currentCycle.status === "completed"` → the *"Clôturer le cycle"* link is in the document, points to `/members/${id}/settlement`.
    - Add a case: `currentCycle.status === "active"` → the *"Clôturer le cycle"* link is NOT in the document.
    - Add a case: `currentCycle.status === "settled"` → the *"Clôturer le cycle"* link is NOT in the document.

18. **No new dialog primitive.** Story 7.3 is a route. No `<dialog>`, no Sheet. Story 7.4 may add a re-auth dialog on top of this route — out of scope.

19. **All gates green.**
    - `npm run typecheck` — strict TS clean.
    - `npm run lint` — no new warnings; cross-feature imports respected (`@/domain/cycle` reads in the route are fine — `domain` is shared; `useMemberProfile` is imported via the feature barrel `@/features/member`).
    - `npm run test -- --coverage` — domain still 100 %; new route file ≥ 80 % branches; the 75 % global gate stays comfortably above 75 %.
    - `npm run build` — bundle delta < 3 kB gzipped (1 route + 1 button + 4 i18n strings; `SettlementSummaryCard` already in the bundle from Story 7.1).
    - `npx playwright test` — UNCHANGED for THIS PR (no new E2E spec ships with 7.3; Story 7.4 will own the Flow 3 E2E that exercises the full settlement flow end-to-end including this route).

20. **Bundle / route-stack health.** After Story 7.3, the `/members/:id/{...}` route family has: `/`, `/edit`, `/advance`, `/settlement`. Verify no router conflicts in `src/app/router.tsx` (the `:id/edit` precedent at line 52 already documents the longer-path-first concern; `:id/settlement` is naturally longer than `:id`).

## Tasks / Subtasks

- [x] **Task 1 — i18n keys** (AC: #12)
  - Add `members.profile.action_settle` to the `members.profile.*` namespace in `src/i18n/fr.json`.
  - Add 3 keys under a new `settlement.flow.*` sub-namespace: `title`, `back_label`, `confirm_pending_toast`. The sub-namespace sits inside the existing `settlement.*` block alongside `settlement.summary.*` (Story 7.1).

- [x] **Task 2 — New settlement route file** (AC: #3, #4, #5, #6, #7, #8, #10, #11, #13)
  - New `src/app/routes/members/[id].settlement.tsx`.
  - 1-line header comment + UUID guard wrapper component (mirror `[id].advance.tsx:26-34` exactly) + inner `SettlementRouteBody({ memberId })` doing the data work.
  - Imports: `Navigate`, `useNavigate`, `useParams` from `react-router-dom`; `ChevronLeft` from `lucide-react`; `toast` from `sonner`; `SettlementSummaryCard` from `@/components/domain/SettlementSummaryCard`; `useMemberProfile` from `@/features/member`; `ProfileError`, `ProfileSkeleton` from `@/components/domain/MemberProfileStates`; `useT` from `@/i18n/useT`; (no `useState` — no in-route state for Story 7.3).
  - Precondition guards return `<Navigate ... replace />` JSX before reaching the card render.

- [x] **Task 3 — Compute advances array** (AC: #7, #13)
  - In `SettlementRouteBody`, after the guards, derive:
    ```ts
    const advances = data.transactions
      .filter((tx) => tx.kind === "advance")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((tx) => tx.amount);
    ```
  - No `useMemo` (cheap arithmetic; component re-renders only when `data.transactions` reference changes — TanStack Query already memoises that).

- [x] **Task 4 — Render the route shell + SettlementSummaryCard** (AC: #11, #7)
  - Outer `<section className="mx-auto flex w-full max-w-md flex-col gap-4 py-6">`.
  - Header: back chevron `<button ... aria-label={t("settlement.flow.back_label")}>` → `navigate(\`/members/\${memberId}\`)`; `<h1 className="text-title-1 text-text-primary px-4">{t("settlement.flow.title")}</h1>`.
  - Mount `<SettlementSummaryCard {...props} />` with all 11 props mapped per AC #7.

- [x] **Task 5 — `onVerifyTransactions` + `onConfirm` handlers** (AC: #9, #10)
  - `onVerifyTransactions = () => navigate(\`/members/\${memberId}\`);` (note: callback ignores both args — route already has them).
  - `onConfirm = () => toast.info(t("settlement.flow.confirm_pending_toast"));` (Story 7.4 will replace this).
  - **CRITICAL — add a code comment** above `onConfirm` saying *"TODO Story 7.4: replace this stub with the password re-auth dialog + cycle-settlement Edge Function commit RPC. Do not remove this comment until Story 7.4 lands."* So the next dev finds it instantly.

- [x] **Task 6 — Router registration** (AC: #3)
  - In `src/app/router.tsx`, add after the `/members/:id/advance` line:
    ```tsx
    { path: "members/:id/settlement", element: <MemberSettlementRoute /> },
    ```
  - Add the matching import: `import MemberSettlementRoute from "@/app/routes/members/[id].settlement";`.

- [x] **Task 7 — MemberProfile header CTA** (AC: #1, #2, #15)
  - In `src/app/routes/members/[id].tsx`, add `const canSettle = currentCycleStatus === "completed";`.
  - Insert the *"Clôturer le cycle"* link-styled button inside the existing `role="group"` actions block, between `Redémarrer le cycle` and `Renvoyer l'historique` (CTAs stay grouped logically: edit → cycle-lifecycle CTAs → SMS-resend → destructive).
  - Pattern: `<Button asChild variant="outline" size="sm"><Link to={\`/members/\${id}/settlement\`}>{t("members.profile.action_settle")}</Link></Button>`.

- [x] **Task 8 — Tests: new route smoke** (AC: #16)
  - New `src/app/routes/members/[id].settlement.test.tsx`. Mirror `[id].test.tsx:1-60`'s `renderRoute(path)` helper pattern.
  - Mock `useMemberProfile` via `vi.mock("@/features/member", ...)` (same shape as `[id].test.tsx:9-17`).
  - Mock `sonner` for the `onConfirm` stub assertion: `vi.mock("sonner", () => ({ toast: { info: vi.fn() } }))`.
  - 10 cases covering: happy-path render with `completed` cycle (assert h1, card content, final payout math), all 4 precondition guards (active / settled / null cycle / invalid UUID redirect), loading state, error state, advance ordering (3 advances, distinct created_at), CTA-stub `toast.info` once, `onVerifyTransactions` navigates to profile.

- [x] **Task 9 — Tests: MemberProfile header CTA extension** (AC: #17)
  - Extend `src/app/routes/members/[id].test.tsx`. Reuse the existing `MEMBER` fixture and `useMemberProfileMock`.
  - Add 3 cases: `currentCycle.status === "completed"` → link present + `href === "/members/${VALID_ID}/settlement"`; `=== "active"` → link absent; `=== "settled"` → link absent.

- [x] **Task 10 — Gate run** (AC: #19)
  - `npm run typecheck && npm run lint && npm run test -- --coverage && npm run build` all green locally.

- [x] **Task 11 — Sprint hygiene**
  - Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `7-3-settlement-initiation-computation` from `ready-for-dev` → `review` once dev completes.
  - Update `last_updated` + touched line in sprint-status.

## Dev Notes

### Why a dedicated route (not a dialog or in-place screen swap)

UX Flow 3 (lines 793-823) calls this a *"Settlement preview screen"* — a distinct screen, not a modal. The deliberate slowness of the settlement ceremony (UX line 822: *"Trust ceremony over speed"*) argues for a dedicated route surface:

- **URL stability.** The collector can refresh the page, share the URL with a teammate (e.g., for verification before a re-auth), and use the browser back button to revisit the profile.
- **Header / h1 ownership.** Story 7.1's component is `<h2>`-rooted by AC #9 because the consuming route owns the `<h1>`. A dialog/sheet would invert this.
- **Story 7.4 wiring slot.** The re-auth dialog + commit RPC will be mounted ON TOP OF this route (not replacing it). A dedicated route is the natural host.
- **Consistency with Story 5.2 / 5.4** (`/members/:id/advance` for the advance flow) — same architectural pattern for a multi-step trust ceremony.

### Why "Vérifier" navigates to the profile (no dedicated drill-down)

The profile route already renders the current-cycle transaction list in newest-first order. Adding a `/members/:id/settlement/verify` sub-route would duplicate that surface. For MVP, the back-and-forth (Settlement → tap "Vérifier" → Profile → tap "Clôturer le cycle" → Settlement) is acceptable. The collector's mental model is intact: *"check the transactions, then close the cycle"*.

**Future enhancement** (NOT this story): a "Back to settlement" CTA in the profile when arriving from `/settlement` — possibly via a query-string hint or a tiny piece of route state. Defer until UX research signals a real friction.

### Why the Confirm stub is a `toast.info`, not a disabled button

Story 7.1's `SettlementSummaryCard` exposes `isSubmitting` as the only disable mechanism for the primary CTA — and it shows the *"Clôture en cours…"* label + spinner, which is not the right UX state for "feature not yet implemented." Adding a new `confirmDisabled` prop to Story 7.1's contract would couple it to Story 7.3's transitional state — bad coupling.

The cleanest stub: the route's `onConfirm` handler dispatches a `toast.info` and stays on the page. The button still looks/feels enabled (because it IS — it does something user-facing, just not the final commit). Story 7.4 replaces the handler in one diff. Document the stub with a clear `TODO Story 7.4` code comment so it can't be forgotten.

### Cycle precondition — server vs. client enforcement

The client-side route guard (AC #6) is a **defence-in-depth UX nicety**, not the canonical enforcement. The actual *"can this cycle be settled?"* check lives server-side in Story 7.4's `cycle-settlement` Edge Function (gated by Postgres's cycle state machine + the `isSettlementReady` predicate). The route guard merely prevents the user from staring at a settlement preview for a cycle they can't actually settle.

If the client guard wrongly redirects (e.g., race condition where the cycle just flipped to `completed`), the user can just refresh — there's no destructive action behind the guard. **Do not over-engineer this check** with a "are you sure you want to leave?" confirmation.

### Code-reuse map (DO NOT reinvent)

| Need | Existing implementation |
|---|---|
| Settlement card UI (header + 4 rows + 2 CTAs) | `SettlementSummaryCard` (Story 7.1) |
| Member + cycle + transactions data | `useMemberProfile(memberId)` (Story 2.4) — already filters transactions to the current cycle |
| Math (commission, settle) | Story 7.1 calls these internally — Story 7.3 never imports `commission` / `settle` directly |
| Loading / error / not-found UI | `ProfileSkeleton`, `ProfileError`, `ProfileNotFound` from `MemberProfileStates` (Story 2.4) |
| UUID regex | `UUID_REGEX` constant copied from `[id].advance.tsx:24` (string-duplicated, not a shared util — matches existing convention) |
| Toast | `sonner` `toast.info` (already imported elsewhere — `[id].tsx:10`) |
| Header back-chevron pattern | Mirror `[id].tsx:65-73` button styling but navigate to `/members/${memberId}` instead of `/members` |
| Button asChild + Link pattern | Mirror `[id].tsx:81-83` (the existing *"Modifier"* CTA) |
| Conditional CTA visibility based on cycle status | Mirror `canRestart` / `canResendHistory` at `[id].tsx:56,61` |

### Anti-patterns to avoid (from past stories' review feedback)

- **DO NOT inline `dailyAmount × 29 − Σ(advances)`.** Story 7.1's card calls `settle()` internally. The route MUST NOT recompute the payout for any reason (e.g., a "sanity check" log statement). NFR-R3 zero-tolerance means ONE source of truth.
- **DO NOT use `useMemo` over the advances filter.** Cheap arithmetic; TanStack already memoises `data.transactions`.
- **DO NOT cast `supabase.rpc` into a free variable.** Not relevant here (no RPC calls in Story 7.3) but the rule from the project memory applies if Story 7.4 lands changes here.
- **DO NOT regenerate `database.types.ts`** during this story — no DB changes.
- **DO NOT add a feature flag** for the new route — straight ship, gate on cycle status only.
- **DO NOT update `_bmad/custom/`** — that's personal config, gitignored.
- **DO NOT use `as` casts** to bypass strict TS — the data shape from `useMemberProfile` is fully typed via Zod schemas.

### Project structure notes

**New files:**
- `src/app/routes/members/[id].settlement.tsx` (≈ 90-100 LOC).
- `src/app/routes/members/[id].settlement.test.tsx` (≈ 200 LOC including helpers + 10 cases).

**Modified files:**
- `src/app/router.tsx` (1 new import + 1 new route entry).
- `src/app/routes/members/[id].tsx` (1 new `canSettle` const + 1 new `<Button asChild>` in the actions group).
- `src/app/routes/members/[id].test.tsx` (3 new cases for the CTA visibility).
- `src/i18n/fr.json` (4 new keys).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip).

All paths align with `architecture.md` (route locations under `src/app/routes/`, shared components under `src/components/domain/`). No cross-feature import violations.

### Testing standards

- Vitest + React Testing Library + `MemoryRouter`.
- Coverage gate (vitest.config.ts): ≥ 80 % global statements / 75 % branches / 80 % functions / 80 % lines. The new route file should hit ≥ 85 % branches.
- The 100 % domain gate on `src/domain/audit/**` and `src/domain/cycle/**` stays unaffected (this story doesn't touch the domain layer).
- No Playwright spec for this story. Story 7.4 will own the Flow 3 settlement E2E.
- **Important:** mock `sonner` carefully for the `onConfirm`-stub test (`vi.mock("sonner", () => ({ toast: { info: vi.fn() } }))`); the existing `[id].test.tsx` mocks `sonner` only for the share flow — Story 7.3's test file needs its own mock.

### Definition-of-done checklist

- All 20 ACs satisfied + all 11 tasks ticked.
- New route file at the canonical path; exports `MemberSettlementRoute` as default.
- Router updated; member profile updated; both test files updated.
- ≥ 10 cases in the new settlement-route test file; ≥ 3 new cases in the existing profile test file.
- All 4 gates green locally: typecheck / lint / `test -- --coverage` / build.
- Story status set to `review`; sprint-status updated; touched-line updated.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 1121-1133 (Story 7.3 BDD), line 379 (Epic 7 user outcome — "Ibrahim clicks 'Clôturer le cycle' for Awa"), lines 1098-1119 (Stories 7.1 + 7.2 — sibling components).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 501 (FR21 — settlement initiation), line 565 (NFR-R3 — zero-tolerance settlement correctness).
- **UX:** `_bmad-output/planning-artifacts/ux-design-specification.md` lines 793-823 (Flow 3 settlement diagram + critical UX detail "deliberate slowness"), lines 679-685 (cycle settlement ceremony design direction), lines 1098-1127 (Settlement summary card states — Story 7.1's component).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` (route placement under `src/app/routes/`, route conventions from Stories 1.x / 2.x / 5.x).
- **Story 7.1 (consumed component):** `_bmad-output/implementation-artifacts/7-1-settlement-summary-card.md` + `src/components/domain/SettlementSummaryCard.tsx` — Story 7.3 mounts this component; pure-presentation contract means Story 7.3 owns all data plumbing and CTA handlers.
- **Story 7.2 (post-commit screen — out of scope for 7.3):** `src/components/domain/EnvelopeHandoverScreen.tsx` — Story 7.4 will mount this after the settlement commit RPC succeeds; not directly imported by Story 7.3.
- **Story 5.2 / 5.4 (route pattern precedent):** `src/app/routes/members/[id].advance.tsx` — same UUID guard + inner-body pattern this story reuses. Router registration at `src/app/router.tsx:57`.
- **Story 2.4 (data hook):** `src/features/member/api/useMemberProfile.ts` — returns `member`, `currentCycle`, `previousCycles`, `transactions` (filtered to current cycle), `stats` (via `computeMemberStats`).
- **Story 2.7 (conditional CTA pattern):** `src/app/routes/members/[id].tsx:56,84-88` — `canRestart` predicate + conditional `<Button>` in the actions group — Story 7.3 mirrors this exactly for `canSettle`.
- **Story 3.2 (cycle engine math source of truth):** `src/domain/cycle/cycleEngine.ts:72` — `settle(dailyAmount, advances)`. Story 7.3 does not call this directly; Story 7.1's card does.
- **Story 7.4 (commit owner — Story 7.3 stubs the Confirm handler for it):** to-be-implemented. Story 7.3's `onConfirm` is a `toast.info` stub explicitly flagged for replacement.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- Initial typecheck failed: my test fixture `COMPLETED_CYCLE.status` was typed as the literal `"completed"` (via `as const`), so overrides like `{ status: "active" }` produced TS2322. Fixed by widening the type to a union (`type CycleStatus = "active" | "with_advance" | "completed" | "settled"`) AND widening the `currentCycle` field in `buildBase()` to `... | null` so the `currentCycle: null` precondition test compiles.
- Initial lint failed with `no-irregular-whitespace` on regex character classes — same NBSP pattern as Stories 7.1 / 7.2. Replaced literal U+00A0 with the explicit ` ` escape via `perl -CSD -i -pe`.

### Completion Notes List

- **New route shipped** at `src/app/routes/members/[id].settlement.tsx` (~110 LOC). UUID guard wrapper + inner `SettlementRouteBody` (data plumbing) mirrors `[id].advance.tsx` exactly. Mounts Story 7.1's `<SettlementSummaryCard>` with the 11 derived props.
- **Precondition guards** (defence-in-depth UX guardrail; server is canonical): UUID malformed → redirect `/members`. `isLoading` → `ProfileSkeleton`. `isError` → `ProfileError`. `currentCycle === null OR status !== "completed"` → redirect `/members/${memberId}`. Settled cycles can't be re-settled; active cycles can't be deep-linked into.
- **Advance ordering** — newest-first via `transactions.filter(advance).sort((a,b) => a.created_at < b.created_at ? 1 : -1).map(amount)` (UX line 1107). Caller-owns-ordering per Story 7.1 AC #1.3.
- **`onConfirm` stub** — `toast.info(t("settlement.flow.confirm_pending_toast"))` with a glaring `TODO Story 7.4` code comment above. Story 7.4 only needs to swap the handler; the route surface is in place.
- **`onVerifyTransactions`** — navigates to `/members/:id` (the profile already lists the current-cycle transactions in newest-first order, exactly what the BDD demands).
- **NFR-R3 zero-tolerance compliance** — the route NEVER recomputes the payout. The card calls `settle(dailyAmount, advances)` from `@/domain/cycle` internally; the route only feeds the inputs.
- **Router registration** — `/members/:id/settlement` added in `src/app/router.tsx` after `/members/:id/advance` (line 58); no precedence concerns (`/edit`, `/advance`, `/settlement` are all longer than the bare `:id`).
- **MemberProfile header CTA** — `"Clôturer le cycle"` button visible iff `currentCycleStatus === "completed"`. Sits between `Redémarrer le cycle` (Story 2.7) and `Renvoyer l'historique` (Story 6.6) in the existing actions group. `canRestart` AND `canSettle` BOTH visible when status === completed — UX intentional (collector chooses restart or settle).
- **i18n** — 4 new keys: `members.profile.action_settle` + `settlement.flow.{title, back_label, confirm_pending_toast}` (new sub-namespace parallel to Story 7.1's `settlement.summary.*`).
- **Tests** — 11 cases in new `[id].settlement.test.tsx` (happy path / 4 precondition guards / UUID guard / loading / error / onConfirm stub / onVerify navigation / advance ordering / back chevron) + 3 new cases in `[id].test.tsx` for `canSettle` CTA visibility (completed shows link, active hides, settled hides).
- **Gates (local)** — typecheck clean, lint clean (max-warnings=0), 670 vitest passed (was 656 → +14: 11 new settlement + 3 profile-CTA), coverage thresholds passed (75.67 % branches global ≥ 75 % gate; settlement route at 100 % stmts / 86.66 % branches / 100 % funcs / 100 % lines; domain still 100 %), build clean (PWA precache 763.75 KiB, delta ~6 KiB raw vs Story 7.2 baseline).
- **No new dependencies, no migrations, no Edge Function, no domain changes** — Story 7.3 is purely route + wiring. Story 7.4 will swap the `onConfirm` stub for the real password re-auth + cycle-settlement Edge Function commit.
- **Code-review patches applied (2026-05-14, reviewer = claude-sonnet-4-6):** Verdict "Approve with suggestions" — 0 HIGH, 1 MEDIUM, 2 LOW. All 3 applied:
  - **[MED + LOW] `[id].settlement.tsx` — callback contract + TODO Story 7.4 enriched.** Single inline comment block documents BOTH: (a) the route intentionally drops the `(memberId, cycleId)` args the card passes (it owns both via closure), AND (b) the TODO Story 7.4 checklist now lists 3 explicit items — swap `handleConfirm`, drive `isSubmitting` from mutation's `isPending` (prevents double-commit), navigate to envelope-handover post-success. Closes a real risk: a Story 7.4 dev could have wired the re-auth handler without enabling `isSubmitting`, leaving both CTAs clickable during the RPC.
  - **[LOW] `[id].settlement.test.tsx` — new precondition guard test for `status === "with_advance"`.** The strict `!== "completed"` check already intercepted `with_advance`, but without a test no regression net existed for a future refactor that decomposed the literal-inequality into an explicit union. 12th test case, mirrors the existing `active` / `settled` / `null` cases.
- **Gates re-run after patches** — 12/12 focused tests green, typecheck + lint clean.

### File List

**New files:**
- `src/app/routes/members/[id].settlement.tsx` — settlement route (≈110 LOC).
- `src/app/routes/members/[id].settlement.test.tsx` — 11 vitest + RTL cases.

**Modified files:**
- `src/app/router.tsx` — `MemberSettlementRoute` import + `/members/:id/settlement` route entry.
- `src/app/routes/members/[id].tsx` — `canSettle` predicate + conditional `Clôturer le cycle` link in the header actions group.
- `src/app/routes/members/[id].test.tsx` — 3 new cases for `canSettle` visibility (completed / active / settled).
- `src/i18n/fr.json` — 4 new keys: `members.profile.action_settle`, `settlement.flow.{title,back_label,confirm_pending_toast}`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `7-3-settlement-initiation-computation` → `review`; updated `last_updated` + touched line.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-14 | Story 7.3 implemented end-to-end via bmad-dev-story — 4 i18n keys, new settlement route file with UUID guard + 4 precondition guards + advance newest-first ordering + Story 7.4 onConfirm-stub (`toast.info`) + onVerify-back-to-profile navigation, router registration, MemberProfile header `Clôturer le cycle` CTA gated on `currentCycle.status === "completed"`, 11 new route tests + 3 new profile-CTA visibility tests, all 4 local gates green (typecheck / lint / 670 vitest / 75.67 % branches global / build, +6 KiB PWA precache). NFR-R3 compliance preserved: route NEVER recomputes payout — Story 7.1's card calls `settle()` internally. | Dev (claude-opus-4-7[1m]) |
| 2026-05-14 | Code-review via bmad-code-review on a different LLM (claude-sonnet-4-6) — verdict "Approve with suggestions" (0 HIGH, 1 MEDIUM, 2 LOW). All 3 patches applied: inline doc for the callback contract (`(memberId, cycleId)` ignored — route owns via closure), enriched TODO Story 7.4 checklist (swap handler + drive `isSubmitting` + post-commit envelope nav), 12th test case for `with_advance` precondition (defence against literal-inequality refactor). Gates re-run green (12/12 focused tests, typecheck, lint). | Reviewer (claude-sonnet-4-6) → Dev (claude-opus-4-7[1m]) |
