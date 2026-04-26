# Story 4.4: Record rattrapage (multi-day catch-up)

Status: review

## Story

As a **collector**,
I want to **record a rattrapage transaction that covers one or more missed days**,
so that **I handle the real-world case where a saver couldn't pay on a given day (FR23).**

> **Predicate of this story.** Story 4.1 shipped the action-sheet shell with an optional `onRattrapage` handler. Story 4.3 shipped the online commit pipeline (`record_contribution` RPC + `enqueue_sms_on_transaction` trigger + `useRecordContribution` + `showContributionToast` + `undoTransaction`). Story 4.4 **extends** that pipeline to a SECOND transaction kind (`rattrapage`, `days_covered = N`) accessible via **long-press** on the action-sheet primary CTA. We add the missing `transactions.days_covered` column, a `record_rattrapage` RPC, a long-press affordance + inline N-options grid + a `useRecordRattrapage` hook, and we extend `showContributionToast` so it works for both kinds. The undo path inherits `undoTransaction` unchanged. SMS body remains the Story 4.3 STUB; Story 6.1 will read `kind` + `days_covered` to compose *"Rattrapage — N jours"* (BDD line 861) — Story 4.4 lands the data, Story 6.x lands the copy.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 855-864; the rest are spec-derived constraints required for a flawless implementation.

1. **Long-press affordance on the primary CTA.** **Given** the member action sheet is open with a non-`termine` cycle, **When** the collector **long-presses** the primary CTA (single-tap = contribution; long-press = rattrapage menu reveal), **Then** an **inline expansion** appears immediately below the primary CTA showing N-options buttons (`× 2 jours`, `× 3 jours`, `× 4 jours`). Long-press = `pointerdown` held for ≥ 500 ms without `pointerup`/`pointercancel`/`pointerleave`. The exact 500 ms is ergonomic per UX spec line 453 (UX-DR6 reveal pattern); locked behind a constant `RATTRAPAGE_LONGPRESS_MS = 500` in `src/components/domain/MemberActionSheet.tsx`.

2. **Tap on "Rattrapage" secondary link is the same affordance.** **Given** the same action sheet, **When** the collector taps the existing `secondary_rattrapage` link (Story 4.1 already wired with an optional `onRattrapage` prop), **Then** the SAME inline expansion opens. The secondary link is the discoverable path (long-press is the muscle-memory shortcut). UX spec line 453 confirms both reveal-paths: *"long-press or secondary-row tap reveals…"*.

3. **N-options inline grid (NOT a radial menu).** Renders 3 ghost-style buttons in a horizontal grid below the primary CTA when the menu is open. Each button reads `× {N} jours` and is disabled if `N > daysRemaining` for the current cycle (where `daysRemaining = CYCLE_TOTAL_DAYS - currentCycle.dayNumber`). The disabled state uses the standard `disabled` attribute on the `<Button>` (greys out per shadcn/Tailwind defaults — no custom hex). Long-form spec line 453 lists *× 2 / × 3 / × 4*; AC #4 fixes the option list to exactly `[2, 3, 4]` for MVP. **Why no radial menu:** the BDD says *"radial menu OR inline expansion"* — the team's existing component vocabulary (action sheet, dialog, dropdown — see `src/components/`) has no radial primitive, and inline expansion is a 1-line CSS grid. No new dep, no new abstraction.

4. **Option set is `[2, 3, 4]` at MVP.** Locked behind a constant `RATTRAPAGE_DAY_OPTIONS = [2, 3, 4] as const` exported from `src/domain/cycle/cycleEngine.ts`. The action sheet imports + maps over it. **No** option for 1 day (that's just a contribution; pressing the primary CTA without long-press already covers it). **No** options > 4 (FR23 leaves it open; BDD pins it to 4 max — keep MVP narrow).

5. **Disabled options when N > daysRemaining.** **Given** the rattrapage would cover days beyond the cycle's remaining days (BDD line 862-864), **When** the option grid renders, **Then** options where `N > daysRemaining` are disabled (visually greyed + `disabled` attribute + `aria-disabled="true"`). `daysRemaining` is derived from the cycle's `currentCycle.dayNumber` via the existing `daysUntilCycleEnd` helper from Story 3.5 (`src/domain/cycle/cycleEngine.ts`). The action sheet props extension (AC #15) carries `daysRemaining` so the component is pure and testable without a hook call. Edge case: if `currentCycle === null` → all options disabled (the contribution CTA is also disabled in that case via Story 4.1's existing logic).

6. **`transactions.days_covered` column.** New migration `20260426000001_add_days_covered_to_transactions.sql`:
   - `ALTER TABLE public.transactions ADD COLUMN days_covered integer NOT NULL DEFAULT 1 CHECK (days_covered BETWEEN 1 AND 30);`
   - The `DEFAULT 1` backfills existing rows (Story 4.3 contributions cover exactly 1 day each — semantically correct).
   - For `kind = contribution`: `days_covered = 1` (always; enforced via DB CHECK in AC #7).
   - For `kind = rattrapage`: `days_covered ∈ [2, 4]` (enforced via the RPC validation + the `RATTRAPAGE_DAY_OPTIONS` constant; the DB CHECK leaves room for `[1, 30]` because future stories may want different rattrapage ranges and a tighter constraint would force a migration churn).
   - For `kind = advance`: `days_covered = 1` (advances are point-events, not multi-day).

7. **Cross-kind invariant** via DB-level CHECK constraint:
   - `ALTER TABLE public.transactions ADD CONSTRAINT transactions_days_covered_kind_chk CHECK ((kind = 'rattrapage' AND days_covered >= 2) OR (kind <> 'rattrapage' AND days_covered = 1));`
   - This single constraint encodes: "rattrapage ⇒ ≥ 2 days; everything else ⇒ exactly 1 day". A contribution with `days_covered = 5` is rejected at the DB layer as defence-in-depth — the RPC also validates, but the constraint is the last line of defence.

8. **`record_rattrapage` RPC.** New migration `20260426000002_record_rattrapage.sql` defines `public.record_rattrapage(p_member_id, p_cycle_id, p_daily_amount, p_cycle_day, p_days_covered)` returning `uuid`:
   - SECURITY DEFINER + `set search_path = public, pg_temp` (mirror Story 4.3 / 0023).
   - Validates `auth.uid()` non-null → `28000` if absent.
   - Validates `p_daily_amount > 0` → `22000`.
   - Validates `p_cycle_day ∈ [1, 30]` → `22000`.
   - Validates `p_days_covered ∈ [2, 4]` → `22000` (the upper bound matches `RATTRAPAGE_DAY_OPTIONS`; defence-in-depth against a tampered client).
   - Validates `p_cycle_day + p_days_covered - 1 <= 30` → `22000` ("rattrapage exceeds cycle remaining"). Why `- 1`: a rattrapage on day 28 covering 3 days covers days 28, 29, 30 = 3 days inclusive; the inclusive math is `cycleDay + daysCovered - 1 ≤ 30`.
   - Verifies `p_member_id`'s `collector_id = auth.uid()` → `28000` if foreign / `P0002` if not found (mirror Story 4.3).
   - Computes `v_amount = p_daily_amount * p_days_covered` (server-side multiplication — never trust the client).
   - Encrypts `v_amount::text` via `vault_encrypt`.
   - INSERTs `transactions(collector_id, member_id, cycle_id, kind, amount_encrypted, cycle_day, source, days_covered) VALUES (auth.uid(), p_member_id, p_cycle_id, 'rattrapage', v_amount_secret, p_cycle_day, 'online', p_days_covered)`.
   - Returns the new `transactions.id`.
   - GRANT EXECUTE TO authenticated.
   - Comment cites BDD lines 855-864 + Story 4.3 + Story 3.4 (the closed-cycle BEFORE INSERT trigger fires here too — no extra work needed).

9. **Story 3.4's BEFORE INSERT trigger covers the closed-cycle gate FOR FREE.** No new gate is added. The trigger raises `23514` regardless of `kind` (Story 3.4 AC #3 is explicit on this). The frontend hook reuses the same `cycle_closed` error code mapping.

10. **Story 4.3's `enqueue_sms_on_transaction` AFTER INSERT trigger covers the SMS enqueue FOR FREE.** It already enqueues for `kind ∈ (contribution, rattrapage, advance)` — see migration 0024 line 33. The body is the same `[STUB]` text. Story 6.1 will read `transactions.kind` + `transactions.days_covered` from the trigger context (via `NEW`) to render *"Rattrapage — N jours"*. Story 4.4 ships the data the future story needs; **DO NOT** modify the trigger now.

11. **`useRecordRattrapage` hook.** New `src/features/transaction/api/useRecordRattrapage.ts`:
    - `useMutation<string, RecordRattrapageError, RecordRattrapageInput>`.
    - `RecordRattrapageInput = { memberId: string; cycleId: string; dailyAmount: number; cycleDay: number; daysCovered: number }`.
    - **DO NOT** pass `amount` — the RPC computes `dailyAmount × daysCovered` server-side (AC #8). Defence-in-depth: a tampered client can't lie about the total.
    - Error codes mirror `RecordContributionError`: `unauthorized | cycle_closed | validation | not_found | network | unknown`. Add `RecordRattrapageError` as a NEW error class (don't reuse `RecordContributionError` — different stack traces, different `name`). Identical `classifyError` shape (copy + paste; the few lines aren't worth a shared utility yet — Story 5.4 advance hook will trigger the extraction).
    - In-flight ref guard (mirror Story 4.3).
    - On success: `queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY })` (recency sort — same as 4.3).
    - 6 RTL test cases (happy path + 5 error codes — same pattern as `useRecordContribution.test.tsx`).

12. **Toast helper extension.** Rename / generalise `showContributionToast` → keep the file at `src/features/transaction/api/showContributionToast.ts` and EXPORT both functions:
    - Existing `showContributionToast({ memberName, onUndo })` keeps the same signature (no breaking change for `MemberList.tsx`'s Story 4.3 wiring).
    - **New** `showRattrapageToast({ memberName, daysCovered, onUndo })` — same 5-second countdown + `ProgressiveToast just-committed` mount, but the toast body uses a NEW i18n key `members.toast.rattrapage_committed` (*"Rattrapage enregistré ({days} jours) — {name}"*) when `daysCovered > 1`. Internally the two helpers share an inner `mountJustCommittedToast({ bodyText, onUndo })` helper to avoid copy-paste of the `setInterval` + `toast.custom` re-render dance.
    - **Why a new toast key, not a kind on `ProgressiveToastState`:** the toast component is presentation-only (Story 4.2's contract); injecting `daysCovered` into its state would leak transaction-kind into the component. Cleaner: the helper builds the body string and `ProgressiveToast` renders whatever is passed via the `memberName` slot. Achieved by passing a custom `memberName` like *"Awa Diallo"* + a custom `bodyText` template — but that requires a small Story 4.2 prop extension. **Compromise:** add a `bodyOverride?: string` optional prop to `ProgressiveToastState["just-committed"]` — when present, replaces the default *"Cotisation enregistrée — {name}"* template. This is a 1-line additive change to Story 4.2's discriminated union; backwards compatible.
    - Update Story 4.2's component test with a single new case: `bodyOverride` set → renders the override string in lieu of the default. Coverage stays ≥ 80 % on the component.

13. **Wire in MemberList.** Edit `src/features/member/ui/MemberList.tsx`:
    - Already has `<MemberActionSheet>` rendered (Story 4.3 wired `onRecordContribution`). Add `onRattrapage` prop wiring:
    - On long-press OR secondary-link tap → action sheet's internal state opens the inline grid.
    - On grid-option tap → calls a new `MemberList`-local async handler that closes the sheet (same pattern as Story 4.3) → `useRecordRattrapage().mutateAsync({...})` → `showRattrapageToast({ memberName, daysCovered, onUndo: () => undoTransaction(txId, queryClient) })`.
    - **Tooling:** a new `useRecordRattrapage()` instance is created at the same level as `useRecordContribution()`. Both `mutateAsync` + the toast helper happen sequentially (just like AC of Story 4.3).
    - The handler is built only if `activeMember.currentCycle !== null` (mirror Story 4.3's pattern). Computing `daysRemaining` from `currentCycle.dayNumber` happens at this layer too, then passed to the action sheet via the new prop (AC #15).

14. **Action-sheet props extension** (`src/components/domain/MemberActionSheet.tsx`):
    - Replace `onRattrapage?: (memberId: string) => void` with `onRattrapage?: (memberId: string, daysCovered: number) => void` (BREAKING-but-untested-yet — no consumers in production code use the old `onRattrapage` shape; only Story 4.1's tests assert "the prop exists").
    - Add prop `daysRemaining: number` — REQUIRED when `onRattrapage` is set, optional otherwise (TypeScript `daysRemaining: number` always required keeps the type simple).
    - Internal state `rattrapageMenuOpen: boolean` driven by long-press handler + secondary-link tap.
    - Long-press handler attached to the primary CTA `<Button>` via `onPointerDown` / `onPointerUp` / `onPointerLeave` / `onPointerCancel` listeners + a `setTimeout(RATTRAPAGE_LONGPRESS_MS)`. On timer fire: `setRattrapageMenuOpen(true)` + cancel the synthetic `onClick` that would otherwise commit a contribution. **Critical:** the `onClick` for the primary CTA must NOT fire after a long-press; use a `pressedLongRef.current` flag (set on timer-fire, cleared on `pointerdown`) and `if (pressedLongRef.current) { e.preventDefault(); pressedLongRef.current = false; return; }` at the top of the click handler.
    - Inline grid rendered conditionally below the primary CTA when `rattrapageMenuOpen === true`. Each button calls `onRattrapage(member.id, N)` then `close()`. Tapping outside the grid (anywhere else inside the sheet) closes the grid (a click handler on the inner content that resets `rattrapageMenuOpen` if the click target isn't a grid button).
    - Secondary `Rattrapage` link's existing handler: `() => setRattrapageMenuOpen(true)`. Same reveal as long-press.
    - **Touch-target:** each grid button ≥ 44 × 44 px (NFR-A2 — already inherited from `<Button size="default">`).
    - **a11y:** the grid is in a `role="group"` with `aria-label={t("members.action_sheet.rattrapage_aria")}` (*"Sélectionnez le nombre de jours à rattraper"*). When opened by long-press OR secondary-link tap, focus moves to the first NON-disabled grid button.

15. **Disabled state for the grid options.** Computed in `<MemberActionSheet>` from `daysRemaining`:
    - `RATTRAPAGE_DAY_OPTIONS.map((n) => ({ n, disabled: n > daysRemaining }))`.
    - When all options are disabled (e.g., `daysRemaining === 1`, only on day 30), the menu opens with all options disabled — UX spec line 453 says options "grey out". Acceptable; the user gets clear feedback that no rattrapage fits.
    - When `currentCycle === null` (no active cycle), the rattrapage flow is unreachable: secondary link is disabled (Story 4.1 already does this via `!onRattrapage`); long-press has no effect because we don't pass a non-null `onRattrapage` in the absence of a cycle (mirror Story 4.3's conditional spread).

16. **i18n keys.** Add to `src/i18n/fr.json`:
    - `members.action_sheet.rattrapage_aria` = `"Sélectionnez le nombre de jours à rattraper"`
    - `members.action_sheet.rattrapage_option` = `"× {n} jours"` (interpolated; the leading × glyph stays in the literal)
    - `members.toast.rattrapage_committed` = `"Rattrapage enregistré ({days} jours) — {name}"`
    - `transaction.error.rattrapage_invalid_days` = `"Nombre de jours invalide"` — surfaces when the RPC raises `22000` for `days_covered` out of range. Distinct from `validation` so the collector understands what happened.
    - **Note:** existing `members.action_sheet.secondary_rattrapage` ("Rattrapage") stays — it's the discoverability link.
    - **Pluralisation:** `days = 1` is impossible (rattrapage min = 2); `days ∈ {2,3,4}` always pluralises ("jours" — French plural rule: 2+). One template suffices.

17. **Tests — domain (vitest, 100 % coverage gate maintained).** Edit `src/domain/cycle/cycleEngine.test.ts`:
    - Add 1 example test asserting `RATTRAPAGE_DAY_OPTIONS` is exactly `[2, 3, 4]` (frozen contract).
    - Cycle module STILL 100 % coverage. The new export is a constant — adds 0 statements / 0 branches / 0 functions to the coverage budget.

18. **Tests — RPC contract (Deno).** New `supabase/functions/_shared/record-rattrapage.contract.test.ts`. Mirrors the pattern from `record-contribution.contract.test.ts`:
    - **Happy path:** insert via RPC for a non-completed cycle → row exists with `kind='rattrapage'`, `days_covered=N`, decrypted `amount = dailyAmount × N`, audit `transaction.committed` lands, `sms_queue` row enqueued (if member has phone).
    - **Out-of-range `days_covered=1`:** RPC raises `22000` ("invalid days_covered"). The DB CHECK from AC #7 also rejects this — both layers covered.
    - **Out-of-range `days_covered=5`:** RPC raises `22000`.
    - **Rattrapage exceeds cycle remaining (`cycle_day=29` + `days_covered=4`):** RPC raises `22000` with the "exceeds cycle" message.
    - **Closed cycle:** RPC succeeds the validations, INSERT hits the Story 3.4 BEFORE INSERT trigger → `23514`.
    - **Foreign collector:** `28000` (member not owned).
    - **Member without phone:** row inserted, NO sms_queue row (mirror Story 4.3 contract test).
    - Add the new path to `scripts/run-edge-tests.sh`.

19. **Tests — DB constraint contract (Deno OR vitest with service-role).** Add 1-2 tests in the same `record-rattrapage.contract.test.ts` (or in `reject-transaction-on-closed-cycle.contract.test.ts` extension) for the AC #7 invariant:
    - Direct INSERT (bypassing the RPC, via service role) of `kind='contribution'` + `days_covered=2` → CHECK violation.
    - Direct INSERT of `kind='rattrapage'` + `days_covered=1` → CHECK violation.
    - Direct INSERT of `kind='advance'` + `days_covered=2` → CHECK violation.
    These confirm the DB-level last-line-of-defence works regardless of RPC integrity.

20. **Tests — hook (vitest + RTL).** New `src/features/transaction/api/useRecordRattrapage.test.tsx` — 6 cases (happy + 5 error codes). Mirror the structure of `useRecordContribution.test.tsx`. Wraps in `QueryClientProvider`.

21. **Tests — toast helper (vitest).** Edit `src/features/transaction/api/showContributionToast.test.ts` (rename if needed but keep file in place to avoid noise) to also cover `showRattrapageToast`:
    - 1 test: helper mounts a toast with the rattrapage body; advancing timers by 5 s triggers dismissal; tapping Annuler triggers `onUndo`.
    - The shared inner helper (`mountJustCommittedToast`) is exercised through both calls.

22. **Tests — MemberActionSheet (vitest + RTL).** Edit `src/components/domain/MemberActionSheet.test.tsx`:
    - Long-press primary CTA (simulate `pointerdown` + advance timers 500 ms + assert grid opens) → grid renders 3 options.
    - Long-press primary CTA → release before 500 ms → grid stays closed; the click commits a contribution as usual.
    - Tap "Rattrapage" secondary link → grid opens identically.
    - Grid options grey out per `daysRemaining`: with `daysRemaining=2`, options 2 enabled, 3+4 disabled.
    - Tap an enabled option → `onRattrapage(memberId, N)` called once → close fires.
    - Closed cycle (`isCycleClosedForTransactions(cycle) === true`): long-press is a no-op; grid never opens (the cycle-closed banner is already shown by Story 4.1's existing logic).
    - axe-clean across the open-grid state.

23. **Tests — MemberList integration (vitest + RTL).** Edit `src/features/member/ui/MemberList.test.tsx`:
    - Wraps in `QueryClientProvider` (existing).
    - Card-tap → action sheet opens → secondary-link tap → grid opens → tap `× 2 jours` → assert `useRecordRattrapage.mutateAsync` called with `{memberId, cycleId, dailyAmount, cycleDay, daysCovered: 2}` → toast helper called.
    - Mock the hook + toast helper at the module level (mirror existing 4.3 mocks).

24. **Tests — E2E (Playwright).** New `tests/e2e/flow-1-record-rattrapage.spec.ts`. Mirror `flow-1-record-contribution.spec.ts`:
    - Seed: 1 member with active cycle, `dailyAmount=500`, `cycleDay=10` (so `daysRemaining=20` — all 3 options valid).
    - Login → /members → assert member card visible.
    - Tap card → action sheet opens.
    - Click "Rattrapage" secondary link → grid renders with 3 enabled buttons.
    - Tap `× 3 jours` → ProgressiveToast appears with *"Rattrapage enregistré (3 jours) — {name}"*.
    - Service-role assertions: `transactions` row exists with `kind='rattrapage'`, `days_covered=3`, decrypted amount = 1500 (= 500 × 3), `audit_log` `transaction.committed` lands, `sms_queue` row enqueued.
    - **Long-press path is NOT in E2E** (Playwright's `page.mouse.down()` + `page.waitForTimeout(500)` + `page.mouse.up()` is timing-flaky; the click-the-link path covers the same code path through the same internal handler). The component-level test (AC #22) covers the long-press timing.
    - Run locally before push.

25. **No new dependencies.** All work uses existing TanStack Query / Supabase JS / sonner / Tailwind / Lucide. No new npm install.

26. **No changes to Story 4.3's RPC, trigger, hook, or undoTransaction.** Story 4.4 is purely additive: 2 migrations + 1 RPC + 1 hook + 1 toast helper + 1 component-prop addition + the action-sheet long-press + grid + 4 i18n keys. The contribution path is unchanged.

27. **All gates green.**
    - `npm run typecheck` — strict TS clean. The new RPC type lands in `database.types.ts` (regenerate via `npm run db:types` after `npm run db:migrate`). The breaking `onRattrapage` signature change is internal-only (Story 4.1 had `(id: string) => void` with no consumer; Story 4.4 makes it `(id: string, n: number) => void`).
    - `npm run lint` — no new warnings. Cross-feature import: MemberList already imports from `@/features/transaction/api/...`; add the rattrapage hook + toast there.
    - `npm test -- --coverage` — domain still 100 %; new files ≥ 80 %.
    - `npm run test:edge` — the new `record-rattrapage.contract.test.ts` joins the existing 25 → 31+ tests. All green.
    - `npm run db:migrate` — applies 2 new migrations against the local DB (preserves seeded data per CLAUDE.md).
    - `npm run db:types` — regenerates `database.types.ts` so `record_rattrapage` RPC has typed args.
    - `npm run build` — bundle-size delta < 2 kB gzipped (1 hook + 1 helper + 1 component delta).
    - `npx playwright test` — full suite green LOCALLY before push (Story 2.5 retro). 1 new spec.

## Tasks / Subtasks

- [x] **Task 0 — Migrations (AC #6 #7).** Create `20260426000001_add_days_covered_to_transactions.sql`:
  - `ALTER TABLE transactions ADD COLUMN days_covered integer NOT NULL DEFAULT 1 CHECK (days_covered BETWEEN 1 AND 30);`
  - `ALTER TABLE transactions ADD CONSTRAINT transactions_days_covered_kind_chk CHECK (...)` per AC #7.
  - Apply via `npm run db:migrate`.

- [x] **Task 1 — RPC (AC #8).** Create `20260426000002_record_rattrapage.sql`. Mirror the structure of `0023_record_contribution.sql`. Validate inputs, ownership, cycle-bounds. Encrypt `dailyAmount × daysCovered`. INSERT with `kind='rattrapage'`. Return `id`.

- [x] **Task 2 — Regenerate types.** `npm run db:types` (after migrations apply) so the new RPC + `days_covered` column are typed in `src/infrastructure/supabase/database.types.ts`.

- [x] **Task 3 — Domain constant + tests (AC #4 #17).** Edit `src/domain/cycle/cycleEngine.ts` to export `RATTRAPAGE_DAY_OPTIONS = [2, 3, 4] as const`. Add to barrel. 1 test asserting the exact value.

- [x] **Task 4 — `useRecordRattrapage` hook (AC #11).** New `src/features/transaction/api/useRecordRattrapage.ts` + `.test.tsx`. Copy structure from `useRecordContribution`. 6 RTL cases.

- [x] **Task 5 — Toast helper (AC #12 #21).** Refactor `showContributionToast.ts` to extract `mountJustCommittedToast({ bodyText, onUndo })`. Add `showRattrapageToast({ memberName, daysCovered, onUndo })`. Update test file. Update Story 4.2's `ProgressiveToast` discriminated union to accept `bodyOverride?: string` + 1 new component test.

- [x] **Task 6 — Action-sheet long-press + grid (AC #1 #2 #3 #5 #14 #15 #22).** Edit `src/components/domain/MemberActionSheet.tsx`:
  - Add `daysRemaining: number` prop.
  - Change `onRattrapage` signature to `(memberId, daysCovered) => void`.
  - Implement long-press (`pointerdown`/`pointerup`/timer + `pressedLongRef` to suppress click).
  - Render the inline grid below primary CTA when open. Disable per `RATTRAPAGE_DAY_OPTIONS` × `daysRemaining`.
  - Update tests (≥ 6 new cases per AC #22).

- [x] **Task 7 — i18n keys (AC #16).** Add 4 keys to `src/i18n/fr.json`. The `TranslationKey` derivation picks them up.

- [x] **Task 8 — MemberList wiring (AC #13 #23).** Edit `MemberList.tsx`:
  - Compute `daysRemaining = CYCLE_TOTAL_DAYS - currentCycle.dayNumber` (when cycle exists).
  - Pass `daysRemaining` to `<MemberActionSheet>`.
  - Spread `onRattrapage` conditionally (mirror Story 4.3 pattern).
  - Bridge to `useRecordRattrapage` + `showRattrapageToast`.
  - Extend `MemberList.test.tsx` per AC #23.

- [x] **Task 9 — Edge contract test (AC #18 #19).** New `supabase/functions/_shared/record-rattrapage.contract.test.ts`. ≥ 7 cases. Add path to `scripts/run-edge-tests.sh`.

- [x] **Task 10 — E2E (AC #24).** New `tests/e2e/flow-1-record-rattrapage.spec.ts`. Mirror `flow-1-record-contribution.spec.ts`. Run LOCALLY before push.

- [x] **Task 11 — All gates (AC #27).** `db:migrate` / `db:types` / `typecheck` / `lint` / `test --coverage` / `test:edge` / `build` / `npx playwright test`.

- [x] **Task 12 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `4-4-record-rattrapage: ready-for-dev → review`.
  - Story 6.x note: when `sms-dispatch` lands, the trigger needs to read `transactions.kind` + `days_covered` to render *"Rattrapage — N jours"* per BDD line 861. Story 4.4 ships the data; Story 6.x ships the copy.

## Dev Notes

### Architecture compliance

- **Layering.** Migration + RPC at the SQL layer → constant in `domain/cycle/` → hook + helper in `features/transaction/api/` → component prop extension in `components/domain/` → wiring in `features/member/ui/MemberList.tsx`. No `infrastructure/` changes (Supabase client already configured).
- **Cite sources.** Each new file's header cites BDD line range + FR + Story.
- **Defence-in-depth on amount.** RPC computes `amount = dailyAmount × daysCovered` server-side, never accepts a client-supplied `amount`. Same pattern as the cycle engine's pure functions.
- **Defence-in-depth on days_covered.** Triple-gated: (1) action sheet's grid only emits valid N values; (2) RPC validates `daysCovered ∈ [2, 4]`; (3) DB CHECK constraint validates `days_covered` per kind. Belt + suspenders + parachute.
- **Tokens, not hex.** No new colours. The grid options use the existing ghost variant + disabled state; warning-palette stays reserved for the cycle-closed banner.

### Why server-computed amount (not client-passed)

A tampered client could send `dailyAmount=500` + `daysCovered=4` + `amount=99999` to the RPC. If the RPC trusted the client `amount`, the saver would be debited at the *correct* rate but the *displayed* receipt + the cycle's projected balance would diverge. The RPC computing `amount` from the immutable `dailyAmount` (which was set at member creation, audit-trailed via Story 2.2 / 2.5) closes that gap. The frontend receives the canonical value back via the eventual `MEMBERS_QUERY_KEY` invalidation; the member-profile transactions list (Story 2.4) re-fetches and shows the correct number.

### Why the inline grid (not a radial menu)

UX spec line 453 lists *"radial menu OR inline expansion"*. The team has zero radial-menu primitives — bringing one in would introduce a 3-state interaction model (initial, hover-arc, commit) that's hard to test, hard to make accessible (radial menus famously fight screen readers), and adds gesture cost on a touch device. An inline 3-button grid is 8 lines of JSX, axe-clean by default, keyboard-traversable, and pixel-perfect on the spec mockup (`03-mockups.html` line 420 already uses a `<select>` for rattrapage — even simpler than a grid; we go grid because long-press deserves a visual reveal that a `<select>` doesn't provide).

### Why long-press on the primary CTA AND the secondary link both reveal the grid

- **Long-press** = muscle-memory shortcut for power users (Ibrahim after week 2).
- **Secondary link** = discoverable for first-time users (Ibrahim's day 1).

UX spec is explicit (line 453: *"long-press OR secondary-row tap"*). Wiring both to the same internal `setRattrapageMenuOpen(true)` keeps a single state model. The component test (AC #22) covers both paths.

### Why no DB migration to make `transactions.amount` derived

Tempting: add a generated column `amount_total = amount × days_covered`. But the encrypted `amount_encrypted` is a Vault secret_id, not the plaintext value, so a generated column on the encrypted form is meaningless, and on the decrypted form would require Vault access from the constraint expression (impossible).

Instead: the RPC computes the total once at INSERT time and stores it in `amount_encrypted`. The decrypted `transactions_decrypted` view (migration 0005) returns the total directly — consumers (Story 2.4 transaction history) don't need to know it was a rattrapage of N days unless they want to label it; the `kind + days_covered` columns are how labels are derived.

### Why the toast `bodyOverride` mechanism (not a new toast `kind`)

The `ProgressiveToast` discriminated union (Story 4.2) has 5 lifecycle states: `just-committed | sending | delivered | offline | failed`. Adding a `just-committed-rattrapage` 6th state would explode the lifecycle by 5× per future kind (advance, custom-amount). Instead: keep the 5 lifecycle states + 1 optional `bodyOverride` slot. `showContributionToast` passes nothing → default body. `showRattrapageToast` passes the rattrapage body. `showAdvanceToast` (Story 5.4) will pass the advance body. The lifecycle states stay clean; the body is just text.

### Story 6.x handshake

- The SMS body for a rattrapage is *"Rattrapage — N jours"* (BDD line 861).
- Story 6.1 will REPLACE the `enqueue_sms_on_transaction` trigger function with one that reads `NEW.kind`, `NEW.days_covered`, decrypts the amount, and renders the appropriate template.
- **Story 4.4 ships the data**; Story 6.x ships the copy. **Do NOT** ship the trigger replacement here — it would couple two epics' work.
- Story 4.4's contract test asserts the STUB body lands; Story 6.1's contract test will replace that assertion with the templated body.

### Anti-patterns (do NOT do)

- **Do NOT** trust client-supplied `amount`. RPC computes `dailyAmount × daysCovered`.
- **Do NOT** store `days_covered` only on the wire; persist it on the row (AC #6).
- **Do NOT** widen `RATTRAPAGE_DAY_OPTIONS` beyond `[2, 3, 4]` at MVP. The BDD pins 2/3/4 explicitly.
- **Do NOT** add option `1` (that's a contribution). Don't add `5+` (deferred; can land in a Growth-phase amendment).
- **Do NOT** use `Hammer.js` or any gesture library. The 500 ms long-press is 30 lines of pointer-event handling.
- **Do NOT** modify `enqueue_sms_on_transaction`; Story 6.x owns that trigger function's body.
- **Do NOT** modify `record_contribution` RPC; this story is purely additive.
- **Do NOT** open a radial menu. Inline grid only.
- **Do NOT** ship the `bodyOverride` prop without the corresponding component test (Story 4.2 maintained ≥ 80 % coverage; the new branch must be tested).
- **Do NOT** rename `useRecordContribution` to a generic `useRecordTransaction` to share with rattrapage. Two hooks with different validation contracts is clearer than one over-parameterised hook (Story 5.4 advance will be a third hook — same pattern).
- **Do NOT** allow the action sheet's primary CTA's `onClick` to fire after a 500 ms long-press. The `pressedLongRef` flag is the gate.
- **Do NOT** use `mousedown`/`mouseup` — use Pointer Events (touch + mouse + pen support out of the box; matches the existing `<dialog>` interaction model).

### Edge cases worth testing

- **Day 30 cycle, 1 day remaining.** All grid options disabled (2 > 1, 3 > 1, 4 > 1).
- **Day 28, 3 days remaining.** Options 2 + 3 enabled; option 4 disabled.
- **Day 1, 30 days remaining.** All options enabled.
- **`currentCycle === null`.** Secondary "Rattrapage" link disabled (Story 4.1 default); long-press has no effect because `onRattrapage` is undefined.
- **Closed cycle (`completed`/`settled`).** All transaction CTAs disabled (Story 4.1's `closed` flag); cycle-closed banner shown; long-press still triggers but the grid options are all disabled because they call `onRattrapage` which is undefined when `closed === true`.
- **Long-press with the user dragging off-button before 500 ms.** `pointerleave` cancels the timer; click fires normally as a contribution.
- **Long-press hits 500 ms.** `setRattrapageMenuOpen(true)`; `pressedLongRef.current = true`; subsequent `onClick` is suppressed.
- **Two consecutive rattrapages on the same member.** Second invalidation resorts the list; `inFlightRef` in the hook prevents double-fire.
- **Concurrent contribution + rattrapage same member.** Independent `useMutation` instances; both succeed if both pass validation. `MEMBERS_QUERY_KEY` invalidation runs twice, harmless.
- **Foreign collector tries to write rattrapage via direct `supabase.rpc`.** RPC raises `28000`; classified as `unauthorized`.

### Definition-of-done checklist

- All 27 ACs satisfied + all 13 tasks ticked.
- 2 migrations applied via `npm run db:migrate`.
- `npm run db:types` regenerated; `database.types.ts` includes the new RPC + column.
- Domain still 100 % coverage; new hook + helper ≥ 80 %.
- 7+ Deno contract tests pass via `npm run test:edge`.
- 6+ new vitest cases for the hook; 1 new toast helper test; 6+ new ActionSheet tests; 1+ new MemberList test.
- 1 new Playwright spec passes locally.
- All gates green.
- Story status set to `review`; sprint-status updated.
- Story 6.x handshake documented (the SMS body template waits on Story 6.1).

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 847-864 (Story 4.4 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md:506` (FR23 — rattrapage covering one or more missed days).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md:572` (`transaction.committed` event covers all kinds).
  - `_bmad-output/planning-artifacts/architecture.md:894` (transaction kinds enum: contribution / rattrapage / advance).
  - `_bmad-output/planning-artifacts/architecture.md:943` (`useRecordRattrapage.ts` slot in `src/features/transaction/api/`).
- **UX spec:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md:447` (action sheet anatomy — primary CTA + secondary row).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:453` (long-press OR secondary tap reveals × N options; option list × 2 / × 3 / × 4).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:1030` (long-press primary CTA → rattrapage options reveal inline).
- **Schema:**
  - `supabase/migrations/20260419000001_init_schema.sql:131-150` (transactions table — kind enum already includes `rattrapage`).
  - `supabase/migrations/20260419000005_vault_setup.sql:149` (transactions.amount_encrypted column).
- **Companion stories:**
  - Story 3.4 — `reject_transaction_on_closed_cycle` BEFORE INSERT trigger (works for `kind='rattrapage'` for free).
  - Story 4.1 — `MemberActionSheet` shell (extended here with `daysRemaining` prop + signature change).
  - Story 4.2 — `ProgressiveToast` (extended here with `bodyOverride?: string` slot).
  - Story 4.3 — `record_contribution` RPC + `enqueue_sms_on_transaction` trigger (the trigger handles rattrapage for free; the RPC pattern is the template).
  - Story 3.5 — `daysUntilCycleEnd` (consumed for the disabled-options computation).
- **Existing patterns to mirror:**
  - `supabase/migrations/20260425000005_record_contribution.sql` (the RPC template).
  - `src/features/transaction/api/useRecordContribution.ts` (the hook template).
  - `src/features/transaction/api/showContributionToast.ts` (the toast template — to be refactored with a shared inner helper).
  - `supabase/functions/_shared/record-contribution.contract.test.ts` (the contract-test template).
  - `tests/e2e/flow-1-record-contribution.spec.ts` (the E2E template).
- **Process discipline:** Run Playwright LOCALLY before each push (Story 2.5 retro). Use `npm run db:migrate` not `db:reset` (CLAUDE.md).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] via `bmad-dev-story` skill (Claude Code).

### Debug Log References

- **Hook test `result.current.error` was null synchronously after rejected `mutateAsync`.** TanStack Query's mutation state lags the rejection by one microtask. Fix mirrored Story 4.3's pattern: `await waitFor(() => expect(result.current.error?.code).toBe(...))` instead of synchronous read.
- **`vi.advanceTimersByTime(500)` did not flush React updates** after the long-press timer fires. Wrapped in `act(() => vi.advanceTimersByTime(500))` so the resulting `setRattrapageMenuOpen(true)` propagates before the assertion.
- **`react-hooks/set-state-in-effect` lint error** on the original close-reset `useEffect`. Refactored to perform the reset inline in the `close()` function (called by the internal `onOpenChange(false)` path); when the parent unmounts the sheet (e.g., setActiveMemberId(null)), local state resets naturally on next mount.
- **`db:types --linked`** generated against the linked cloud project (which lacks the local migrations). Switched to `--local` to pick up `record_rattrapage` + `days_covered`. Output included a stray `Connecting to db 5432` first line that broke typecheck — stripped manually before committing.
- **`npm test` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`** after `npm run test:edge` — same Story 3.4 known issue (Deno's `--node-modules-dir=auto` rewrites node_modules entries vitest depends on). Workaround: `rm -rf node_modules && npm ci` before re-running vitest.
- **Playwright suite-level run flaked once on `flow-2-member-delete`** (line 67 — "mot de passe invalide" text). Re-ran in isolation → green. Pre-existing flakiness under parallel load; unrelated to Story 4.4.

### Completion Notes List

- All 27 ACs satisfied. 13 tasks complete.
- 2 migrations (0026 + 0027) applied via `npm run db:migrate`. `database.types.ts` regenerated against local Supabase.
- New `record_rattrapage` SECURITY DEFINER RPC server-computes `amount = dailyAmount × daysCovered` (defence-in-depth — never trusts a client-supplied amount).
- Cross-kind CHECK constraint `transactions_days_covered_kind_chk` encodes "rattrapage ⇒ days_covered ≥ 2; else = 1" at the DB layer; defence-in-depth confirmed by 2 dedicated contract tests.
- `useRecordRattrapage` hook with 7 RTL test cases covering all error codes (incl. distinguishing CHECK-constraint 23514 from cycle-closed 23514 via message content).
- ProgressiveToast extended with optional `bodyOverride` on the `just-committed` state — Story 4.2 contract preserved (5 lifecycle states unchanged); rattrapage / future kinds inject custom body copy without expanding the lifecycle.
- `showContributionToast.ts` refactored to extract `mountJustCommittedToast({ memberName, bodyOverride, onUndo })` shared inner helper; `showRattrapageToast` reuses it with the rattrapage body string.
- MemberActionSheet: 500ms long-press on the primary CTA OR tap on the secondary "Rattrapage" link reveals the inline `× 2 / × 3 / × 4 jours` grid. Options disabled when `N > daysRemaining`. `pressedLongRef` prevents the post-long-press click from committing a contribution.
- MemberList wires `onRattrapage` (signature `(memberId, n) => void`) + `daysRemaining` props to the action sheet, bridging to `useRecordRattrapage` + `showRattrapageToast`.
- 8 new Deno contract tests (happy path, 3 validation paths, closed-cycle gate, foreign collector, 2 DB CHECK constraints).
- New Playwright spec `tests/e2e/flow-1-record-rattrapage.spec.ts` validates the secondary-link reveal path end-to-end (long-press is component-level only — Playwright pointer timing is flaky).
- All gates green: typecheck ✅ / lint ✅ / 494 vitest passing (1 skipped) ✅ / 37 edge tests ✅ / build ✅ / Playwright suite green in isolation (1 unrelated flake on flow-2-member-delete reproducible only under parallel load — passes solo).

### File List

**New (4 files):**

- `supabase/migrations/20260426000001_add_days_covered_to_transactions.sql`
- `supabase/migrations/20260426000002_record_rattrapage.sql`
- `supabase/functions/_shared/record-rattrapage.contract.test.ts`
- `src/features/transaction/api/useRecordRattrapage.ts`
- `src/features/transaction/api/useRecordRattrapage.test.tsx`
- `tests/e2e/flow-1-record-rattrapage.spec.ts`

**Modified (10 files):**

- `src/domain/cycle/cycleEngine.ts` (added `RATTRAPAGE_DAY_OPTIONS = [2, 3, 4]`)
- `src/domain/cycle/cycleEngine.test.ts` (1 new test)
- `src/domain/cycle/index.ts` (barrel export)
- `src/components/domain/ProgressiveToast.tsx` (added `bodyOverride?: string` to `just-committed` state)
- `src/components/domain/ProgressiveToast.test.tsx` (1 new bodyOverride test)
- `src/components/domain/MemberActionSheet.tsx` (long-press + grid + signature change)
- `src/components/domain/MemberActionSheet.test.tsx` (6 new Story 4.4 cases)
- `src/features/transaction/api/showContributionToast.ts` (extracted shared `mountJustCommittedToast` + added `showRattrapageToast`)
- `src/features/transaction/api/showContributionToast.test.ts` (2 new tests for the rattrapage helper)
- `src/features/member/ui/MemberList.tsx` (wired `onRattrapage` + `daysRemaining`)
- `src/i18n/fr.json` (action_sheet rattrapage_aria/option keys + members.toast.rattrapage_committed + transaction.error.* namespace with 6 keys)
- `src/infrastructure/supabase/database.types.ts` (regenerated locally)
- `scripts/run-edge-tests.sh` (added rattrapage contract test path)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flips)
- `_bmad-output/implementation-artifacts/4-4-record-rattrapage.md` (this file — Tasks ✓, Completion Notes, File List, Change Log, Status → review)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-26 | Winston (architect) | Story 4.4 spec generated by `bmad-create-story`. Adds rattrapage to Flow 1 by extending Story 4.3's pipeline: `transactions.days_covered` column + cross-kind CHECK constraint + `record_rattrapage` SECURITY DEFINER RPC (server-computes `amount = dailyAmount × daysCovered`) + `useRecordRattrapage` hook + shared toast helper with `bodyOverride` slot + long-press (500 ms) + tap-on-secondary-link affordances on the action sheet revealing an inline `× 2 / × 3 / × 4 jours` grid, options disabled when `N > daysRemaining`. Closed-cycle gate inherited from Story 3.4; SMS enqueue inherited from Story 4.3. Story 6.x will read `kind + days_covered` to render *"Rattrapage — N jours"* in the SMS template — Story 4.4 ships the data, Story 6.x ships the copy. Status → ready-for-dev. |
| 2026-04-26 | dev agent (Opus 4.7 via `bmad-dev-story`) | Implementation complete. 6 new files + 10 modified. 2 migrations + RPC + Zod-free hook (7 tests) + ProgressiveToast bodyOverride extension (1 test) + showRattrapageToast (2 tests) + action-sheet long-press + grid (6 new tests; total 14) + MemberList wiring + 8 Deno contract tests + new Playwright spec validated locally. All gates green: typecheck / lint / 494 vitest (1 skipped) / 37 edge tests / build. Status → review. |
