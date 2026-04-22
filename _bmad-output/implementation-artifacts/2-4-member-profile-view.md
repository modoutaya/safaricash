# Story 2.4: View member 360 profile with transaction history

Status: ready-for-dev

## Story

As a **collector (Ibrahim) standing in front of a saver who asks "what did I pay last Wednesday?"**,
I want **to tap the saver's row in my list and immediately see their full profile — daily amount, cycle day, cumulative contributed, outstanding advances, projected final balance, and a chronological list of every transaction this cycle**,
so that **I can answer any saver question on the spot without flipping a paper notebook, and resolve disputes by pointing at a timestamped row (FR13)**.

## Acceptance Criteria

1. **Route — `/members/:id`.** New protected route `src/app/routes/members/[id].tsx` registered in `src/app/router.tsx` under the existing `<ProtectedRoute>` tree. The `:id` segment is the `members.id` UUID. The route reads it via `useParams<{ id: string }>()` and refuses to render (404-style "membre introuvable" message + back-to-list CTA) if (a) the param is not a UUID OR (b) the query returns no row (RLS rejects + the user isn't allowed to see this member).

2. **Tap-to-open from the member list.** Wire `MemberCard`'s existing `onSelect` prop in `src/features/member/ui/MemberList.tsx` — tapping a member row navigates to `/members/:id`. The `MemberCard` component's `interactive` branch was added in Story 2.1 anticipating this story; this AC wires the missing piece. Update `MemberList.test.tsx` to assert the rendered `<button>` (interactive variant) carries `data-member-id={member.id}` and a click navigates correctly. The header CTA / FAB toggle from Story 2.2 stays unchanged.

3. **Profile header — 8 datapoints in a single card.** `src/features/member/ui/MemberProfile.tsx` renders a header section with:
   - **Avatar** (initials, 56×56 px — bigger than the 40 px list avatar to give the profile visual weight)
   - **Name** (h1)
   - **Phone** (optional row — hidden if member has no phone)
   - **Daily amount** ("500 FCFA / jour")
   - **Status badge** (Actif / Avance / Terminé via the existing `<StatusBadge>` from Story 2.1)
   - **Cycle day** ("Jour 12 sur 30")
   - **Cumulative contributed** ("Versé : 12 000 FCFA")
   - **Outstanding advances** ("Avances en cours : 5 000 FCFA" — hidden if zero so the layout doesn't wear visual weight for nothing)
   - **Projected final balance** ("Solde prévu fin cycle : 84 000 FCFA" — visually emphasized with `text-display` class because this is the number the saver actually cares about)
   All numeric fields use `font-variant-numeric: tabular-nums` (Story 2.1 pattern) so digits align under repeated viewing. Layout: a vertical stack on mobile, capped at `max-w-md`.

4. **Transaction history — chronological flat list, newest first.** Below the header, render a `<ul>` of every transaction in the **current** cycle (filtered by `transactions.cycle_id = currentCycle.id`). One `<li>` per transaction with:
   - Kind icon (lucide: `ArrowDownToLine` for contribution, `RotateCcw` for rattrapage, `Coins` for advance — establish the icon mapping in a tiny shared module `src/features/member/api/transactionIcon.ts` for downstream reuse).
   - Kind label (i18n: *"Cotisation"* / *"Rattrapage"* / *"Avance"*).
   - Amount (tabular-nums; advances rendered with a leading `−` sign and the `text-warning` token to differentiate visually).
   - Timestamp (`created_at`, formatted as `"lun. 12 avr. à 09:14"` via `Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })` — encapsulated in `src/features/member/api/formatTransactionTime.ts`).
   - Cycle-day chip (`"J12"` small badge in the right gutter).
   - **Non-interactive at MVP.** Tapping a transaction is **out of scope** here — it's Story 6.7 (Per-transaction receipt share + re-deliver). For now the row is a plain `<article>`, no click handler. AC #13 lists this explicitly.
   Empty-state: when the cycle has zero transactions yet (day 1, fresh member from Story 2.2), render *"Aucune transaction enregistrée pour ce cycle."* — calm, no emoji, no CTA.

5. **Pure computation — `computeMemberStats(transactions, member, currentCycle, now)`.** New file `src/features/member/api/computeMemberStats.ts`:
   ```typescript
   export interface MemberStats {
     cycleDay: number;        // 1..30 (clamped, same logic as Story 2.1)
     daysRemaining: number;   // 30 - cycleDay
     contributedTotal: number; // sum of contributions + rattrapages
     outstandingAdvances: number; // sum of advances
     projectedFinalBalance: number; // FR17 formula
   }
   export function computeMemberStats(
     transactions: TransactionRow[],
     member: { dailyAmount: number },
     currentCycle: { startDate: string } | null,
     now?: Date,
   ): MemberStats;
   ```
   Formula per FR17 (line 497 of `prd.md`): `projectedFinalBalance = (daily_amount × 30) − (1 × daily_amount) − Σ(outstanding advances)` = `daily_amount × 29 − Σ(advances)`. The "−1×daily_amount" term is the collector's commission day. **Defensive note:** this formula is the canonical FR17 spec. Story 3.2 (cycle engine) will take ownership of cycle math behind a pure-function module under `src/domain/cycle/`. Until 3.2 lands, this story owns the inline implementation — flag with a `// TODO(Story 3.2): move to src/domain/cycle/cycleEngine.ts` comment so the refactor is grep-able. **Pure function, 100 % unit-tested.**

6. **`useMemberProfile(id)` hook — `src/features/member/api/useMemberProfile.ts`.** TanStack `useQuery` (NOT a mutation):
   - Three parallel PostgREST round-trips via `Promise.all` (matching Story 2.1's `useMembers` pattern):
     - `members_decrypted` filtered by `id = $1` → single row.
     - `cycles` filtered by `member_id = $1` → all cycles (we need the most recent active or with_advance one as "current").
     - `transactions_decrypted` filtered by `member_id = $1` → all transactions (we'll filter to the current cycle in JS — the row count per member is bounded at ~30/cycle × 12 cycles/year = ~360 lifetime, so client-filtering is cheap and avoids a second join roundtrip).
   - Zod-validate each response at the boundary (re-use `memberRowSchema`, `cycleRowSchema` from Story 2.1; add `transactionRowSchema` here as the first server-shape Zod for transactions — Story 4.x will re-export from this story).
   - Returns `{ data: { member, currentCycle, transactions, stats } | undefined, isLoading, isError, error }` where `stats` is the result of `computeMemberStats`.
   - Query key: `["members", "profile", id]`. **Invalidated by:** Story 4.x writing transactions, Story 2.5 editing member, Story 2.6 deleting member, Story 2.7 restarting cycle. None of these are downstream of 2.4 — we just expose the key as `MEMBER_PROFILE_QUERY_KEY = ["members", "profile"] as const` so future consumers can match the prefix.
   - `staleTime: 30_000` (same as `useMembers`).

7. **Loading / error / not-found states.**
   - `isLoading`: a header-skeleton (avatar circle + 3 text lines) + a list-skeleton (3 rows). Use Tailwind `animate-pulse` + `bg-neutral-100`. Pattern matches Story 2.1's "no-skeleton" decision EXCEPT for this view because the data is a deeper read; a flash of empty would be confusing.
   - `isError` (PostgREST 5xx): full-section `role="alert"` with copy *"Impossible de charger le profil. Réessayez dans un instant."* + a *"Retour"* button → `navigate("/members")`.
   - `data === undefined` after loading completes (RLS rejected the row OR id is bogus): full-section *"Membre introuvable."* + back CTA. Same shape as `isError`.

8. **Header back-chevron — `navigate("/members")`.** Top-left chevron button (44 × 44 px target, `aria-label="Retour à la liste des membres"`). Mirrors the `/members/new` and `/members/import` headers from Stories 2.2 / 2.3.

9. **Action overflow menu — header right side, placeholder for Stories 2.5 / 2.6 / 2.7.** A `<button>` with the `MoreVertical` icon (44 × 44 px, `aria-label="Actions"`). On click, open a shadcn `<DropdownMenu>` (NEW component — `npx shadcn add dropdown-menu` if not already present) with three placeholder items:
   - *"Modifier"* → `disabled` (Story 2.5 will wire it).
   - *"Redémarrer le cycle"* → `disabled` (Story 2.7).
   - *"Supprimer"* → `disabled` (Story 2.6 — needs FR5 re-auth).
   Each disabled item has a `title` tooltip *"Disponible bientôt (Story 2.X)"*. **Rationale:** the menu structure lands here so downstream stories only need to flip the `disabled` flag + wire the click — no refactor of the header layout. If shadcn dropdown installation is too heavy a dep for an MVP placeholder, fall back to inline disabled buttons in a row (less polish but zero new dep).

10. **i18n keys (French) — added under `members.profile.*`.** `src/i18n/fr.json`:
    - `members.profile.back_label` ("Retour à la liste des membres")
    - `members.profile.actions_label` ("Actions")
    - `members.profile.action_edit` ("Modifier")
    - `members.profile.action_restart_cycle` ("Redémarrer le cycle")
    - `members.profile.action_delete` ("Supprimer")
    - `members.profile.action_disabled_tooltip` ("Disponible bientôt")
    - `members.profile.field.daily_amount` ("{amount} FCFA / jour")
    - `members.profile.field.cycle_day` ("Jour {n} sur 30")
    - `members.profile.field.contributed_total` ("Versé : {amount} FCFA")
    - `members.profile.field.outstanding_advances` ("Avances en cours : {amount} FCFA")
    - `members.profile.field.projected_balance` ("Solde prévu fin cycle : {amount} FCFA")
    - `members.profile.transactions.title` ("Historique du cycle")
    - `members.profile.transactions.empty` ("Aucune transaction enregistrée pour ce cycle.")
    - `members.profile.transactions.kind_contribution` ("Cotisation")
    - `members.profile.transactions.kind_rattrapage` ("Rattrapage")
    - `members.profile.transactions.kind_advance` ("Avance")
    - `members.profile.transactions.cycle_day_chip` ("J{n}")
    - `members.profile.error.load` ("Impossible de charger le profil. Réessayez dans un instant.")
    - `members.profile.error.not_found` ("Membre introuvable.")
    - `members.profile.error.back_cta` ("Retour")

11. **Public surface — barrel export.** `src/features/member/index.ts` adds:
    - `export { useMemberProfile, MEMBER_PROFILE_QUERY_KEY } from "./api/useMemberProfile";`
    - `export { computeMemberStats } from "./api/computeMemberStats";`
    - `export type { MemberStats, TransactionRow, TransactionKind } from "./types";`
    - `export { MemberProfile } from "./ui/MemberProfile";`
    Internal helpers (`transactionIcon`, `formatTransactionTime`) stay private to the feature — not in the barrel.

12. **Tests.**
    - **Vitest unit (`computeMemberStats.test.ts`):** ≥ 8 cases — empty transactions, contribution-only, contribution+rattrapage, advance-only, mixed, day-1 floor, day-30 ceiling, no current cycle (returns zeros). Property-based bonus: pick a random daily amount + random transaction set, assert `projectedFinalBalance + outstandingAdvances + (dailyAmount × 1) === dailyAmount × 30 − contributedTotal_shortfall` (skip if too cute — 8 explicit cases is the floor).
    - **Vitest unit (`formatTransactionTime.test.ts`):** ≥ 4 cases covering different days/months in fr-FR locale + 24-hour clock + a midnight edge.
    - **Vitest unit (`useMemberProfile.test.tsx`):** mock supabase. Cover (a) happy path returns the joined view-model with computed stats; (b) member-not-found → undefined data + isLoading false; (c) one of the 3 queries fails → isError true; (d) Zod parse failure → isError true.
    - **Vitest component (`MemberProfile.test.tsx`):** RTL + jest-axe. Render with mock data — assert all 8 header datapoints render, advances row hidden when 0, transaction list renders N rows with right kind labels + amounts, empty-state copy renders when 0 transactions, jest-axe-clean.
    - **Vitest component (`MemberProfileRoute.test.tsx`):** smoke — renders the loading skeleton on `isLoading`, error copy on `isError`, "membre introuvable" when `data === undefined` post-load, full profile on success. Routes the back chevron correctly.
    - **Vitest component (`MemberList.test.tsx`):** add 1 new case asserting that tapping a `MemberCard` (now interactive) navigates to `/members/:id` (use `MemoryRouter` + assert `useNavigate` mock fires with the right path — pattern matches `MembersNewRoute.test.tsx`).
    - **Playwright E2E (`tests/e2e/flow-2-member-profile.spec.ts`):** env-gated via `SUPABASE_TEST_SEED_READY`. Uses `seedMembersForCollector` from `tests/e2e/fixtures/seed-collector.ts` (already added by Story 2.1) to seed 1 member + 1 cycle + 1 transaction. Drive: `/members` → click row → assert URL `/members/<uuid>` → assert name + amount + 1 transaction visible → assert axe-clean.
    - **Coverage gate:** `src/domain/` stays at 100 % (this story doesn't touch it yet — Story 3.2 will). Overall floor 80 % (the 75 % branches we just barely cleared in Story 2.3 might tighten — keep an eye on it during dev).

13. **Out of scope (do NOT expand this story).**
    - Per-transaction tap → receipt share / re-deliver — Story 6.7.
    - Edit member action — Story 2.5 (placeholder disabled item only).
    - Delete member action — Story 2.6 (placeholder disabled item only; needs FR5 re-auth from Story 1.3 which Story 1.5b rewrote).
    - Restart cycle action — Story 2.7 (placeholder disabled item only).
    - Inline dispute banner on the profile (architecture line 956 anticipates `DisputeInlineBanner.tsx`) — Story 10.3.
    - Real-time live updates of the profile when a new transaction lands. The 30 s `staleTime` + a manual pull-to-refresh (deferred to Story 8.x) is enough at MVP.
    - PDF export / printable view — out of MVP scope per PRD § Growth.
    - Multi-cycle history (showing previous completed cycles below the current one). MVP shows ONE current cycle only; "Historique des cycles" deferred to Growth.
    - Domain-layer cycle engine (`src/domain/cycle/`) — Story 3.2 owns the canonical home. This story has the formula inline, flagged with a TODO comment so 3.2 can grep + relocate.

## Tasks / Subtasks

- [ ] **Task 1: Pure computation `computeMemberStats`.** `src/features/member/api/computeMemberStats.ts` per AC #5. ≥ 8 unit-test cases. Inline FR17 formula with `// TODO(Story 3.2): move to src/domain/cycle/`.

- [ ] **Task 2: `formatTransactionTime` helper.** `src/features/member/api/formatTransactionTime.ts` per AC #4 — `Intl.DateTimeFormat("fr-FR", ...)` wrapper. 4 unit-test cases.

- [ ] **Task 3: `transactionIcon` mapping.** `src/features/member/api/transactionIcon.ts` — pure `(kind: TransactionKind) => LucideIcon` lookup. 1 trivial test (3 kinds → 3 icons).

- [ ] **Task 4: `transactionRowSchema` + types.** `src/features/member/types.ts`:
  - [ ] Add `transactionKindSchema = z.enum(["contribution", "rattrapage", "advance"])` mirroring `public.transactions_kind_enum` (migration 0001 line 49).
  - [ ] Add `transactionRowSchema` with `id`, `member_id`, `cycle_id`, `kind`, `amount` (number — coerced from numeric(12,0)), `cycle_day` (1..30), `created_at` (ISO string).
  - [ ] Add `TransactionKind` + `TransactionRow` types via `z.infer`.
  - [ ] `MEMBER_PROFILE_QUERY_KEY` constant.
  - [ ] `MemberStats` interface.

- [ ] **Task 5: `useMemberProfile(id)` hook.** `src/features/member/api/useMemberProfile.ts` per AC #6. Three parallel PostgREST queries → Zod-parse → `computeMemberStats` → return view-model. Vitest unit per AC #12.

- [ ] **Task 6: `MemberProfile` component.** `src/features/member/ui/MemberProfile.tsx` per ACs #3, #4. Pure presentation: receives `{ member, currentCycle, transactions, stats }` props (no hook calls) so the route owns data fetching. RTL + jest-axe.

- [ ] **Task 7: `/members/:id` route.** `src/app/routes/members/[id].tsx`:
  - [ ] Read `id` via `useParams`.
  - [ ] Call `useMemberProfile(id)`.
  - [ ] Render skeleton / error / not-found / `<MemberProfile>` per AC #7.
  - [ ] Header: back chevron + `MoreVertical` actions menu per ACs #8, #9.
  - [ ] Register in `src/app/router.tsx` under the protected tree, AFTER `/members/new` + `/members/import` so the static paths win precedence.

- [ ] **Task 8: Wire `MemberCard.onSelect` in `MemberList`.** `src/features/member/ui/MemberList.tsx` line ~145:
  - [ ] Pass `onSelect={(memberId) => navigate(\`/members/\${memberId}\`)}` to `<MemberCard>`.
  - [ ] `MemberList.test.tsx` adds the navigation-on-tap assertion.

- [ ] **Task 9: shadcn `DropdownMenu` install + skin.** `npx shadcn add dropdown-menu`. Re-skin to match the SafariCash tokens (no `oklch()` placeholders — same anti-pattern Story 1.5 review caught). If install pulls non-trivial deps, fall back to inline disabled buttons in a row (per AC #9 fallback note).

- [ ] **Task 10: i18n keys.** Add the `members.profile.*` block from AC #10 to `src/i18n/fr.json`. `npm run typecheck` will catch missing references.

- [ ] **Task 11: Tests.** Per AC #12. `npm run test` / `npm run typecheck` / `npm run lint` / `npm run build` all green before marking review.

- [ ] **Task 12: Sprint hygiene.** Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `2-4-member-profile-view` from `backlog` → `ready-for-dev` (set when this file is generated) → `in-progress` (when dev starts) → `review` (when complete). Add Completion Notes + File List + Change Log entry.

## Dev Notes

### Why the profile inlines FR17 instead of waiting for Story 3.2

Story 3.2 ships the canonical pure-function cycle engine (`src/domain/cycle/cycleEngine.ts`) with 100 % coverage + property-based tests. The right home for `projectedFinalBalance`, `cycleDay`, `daysRemaining` is there. But Story 2.4 is needed BEFORE 3.2 in the MVP critical path (collector cannot answer saver questions without it). Inlining the formula in `computeMemberStats.ts` with a `TODO(Story 3.2)` comment is the right pragmatic choice — when 3.2 lands, a grep + 1-file move replaces the implementation without changing any callers. The unit tests transfer with the file.

### Why client-side filtering of transactions instead of server filter

`useMemberProfile` queries ALL the member's transactions (across all their cycles), not just the current cycle. Then JS filters to `cycle_id === currentCycle.id` for the rendered list. Rationale:
- **Cycle count per member is bounded** — at MVP, ~12 cycles/year × ~30 transactions = 360 lifetime rows. A single SELECT returns the lot in < 50 ms.
- **Avoids a chicken-and-egg query** — the alternative is to first fetch the cycles, find the current one, then fetch transactions filtered by that cycle's id. Two sequential round-trips. The all-transactions-then-filter approach saves one RTT.
- **Story 2.5 / 2.6 / 2.7 will need the full transaction history anyway** — restart-cycle, edit-member-impact-alert, and audit-trail consumers all want cross-cycle data. Loading it once + caching is cheaper than N partial queries.

### Decrypted view → PostgREST → Zod parse

The same pattern as Story 2.1's `useMembers`. The `members_decrypted` view is the read path (security_invoker = true → caller's RLS applies). `transactions_decrypted` already exists from migration 0005 — verified line 177 ("amount is numeric(12,0)"). The Zod boundary parse is mandatory per CLAUDE.md (architecture line 339: "Zod client-side ... two-layer defence in depth").

### Re-using Story 2.1 + 2.2 patterns

- `MEMBERS_QUERY_KEY` (Story 2.1) is the LIST-level key; `MEMBER_PROFILE_QUERY_KEY` is a separate prefix. Future invalidations from Story 2.5 / 2.6 / 4.x will invalidate BOTH.
- `MemberCard.onSelect` was added in Story 2.1 anticipating this story (the comment on line 5 of that file says: "Story 2.1 wires it non-interactive; Story 2.4 profile view will flip it to interactive."). Honor the comment.
- `formatFcfaAmount` from Story 2.1 (`src/features/member/api/formatAmount.ts`) is the canonical FCFA formatter — reuse for all amount displays in the profile.
- `memberInitials` from Story 2.1 — reuse for the avatar.
- `StatusBadge` + `CycleProgressBar` from Stories 2.1 / 1.5 — reuse for the status + cycle-progress display.
- The header layout pattern (back chevron + title) from `/members/new` (Story 2.2) and `/members/import` (Story 2.3) — reuse for visual consistency.

### Layering compliance

- All new code lives in `src/features/member/` (api/ + ui/) and `src/app/routes/members/[id].tsx`. No cross-feature imports.
- The route only imports from `@/features/member` (barrel) + `@/components/ui/*` + `react-router-dom` + `@/i18n/useT`.
- The `transactionRowSchema` lands in `src/features/member/types.ts` even though Story 4.x will be the primary writer of transactions — the SHAPE is the same regardless of who writes; co-locating with the read consumer (this story) is fine.

### Anti-patterns to avoid

- **Do NOT call `supabase.from("members").select(...)` directly** — use `members_decrypted`. RLS + decryption depend on the view path.
- **Do NOT inline the FR17 formula in JSX** — it lives in `computeMemberStats` so unit tests cover it. JSX gets the result via `stats.projectedFinalBalance`.
- **Do NOT add a "share / re-deliver" action on transaction rows** — Story 6.7 owns it. The transaction list is **non-interactive** at MVP.
- **Do NOT pull pull-to-refresh** — defer to Story 8.x offline-sync.
- **Do NOT show previous-cycle transactions** — out of MVP scope. Filter strictly to `currentCycle.id`. If the member has no current cycle (unusual; would mean their cycle is `completed` or `settled` and not yet restarted), show the empty state.
- **Do NOT navigate to `/members/:id` in MemberCard itself** — pass the navigation as a prop (`onSelect`) so the card stays presentation-only and easy to test in isolation. The wiring lives in `MemberList`.

### Definition-of-done checklist

- All 13 ACs satisfied + all 12 tasks ticked.
- New routes registered in router; back chevron returns to `/members`.
- Coverage gate (Vitest v8 thresholds: 80 statements / 75 branches / 80 functions / 80 lines) holds — write enough tests for the 3 new components + 1 new hook to pull the metrics up at least where they were post-2.3.
- Manual smoke test: log in as the test collector → tap a member with ≥ 1 transaction → assert all 8 header datapoints + transaction list render correctly.
- `npm run typecheck` / `npm run lint` / `npm run test` / `npm run build` all green.
- Story status set to `review`; sprint-status updated; Change Log entry added.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 640-653 (Story 2.4 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 490 (FR13 — full profile), line 497 (FR17 — projected balance formula), line 526 (FR36 — share/re-deliver, Story 6.7's territory).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` line 855 (`[id].tsx`), line 923 (`MemberProfile.tsx`), line 956 (`DisputeInlineBanner.tsx` — Story 10.3, anchored on this profile but out of scope here).
- **UX:** `_bmad-output/planning-artifacts/ux-design-specification.md` line 153 (member profile = "timestamped truth in one tap" — the day-15 dispute scene), line 202 (dispute lands privately on member profile), line 634 (skeleton loaders for member profile).
- **Schema:** `supabase/migrations/20260419000001_init_schema.sql` lines 80-100 (members), lines 105-118 (cycles), lines 131-143 (transactions), line 49 (`transactions_kind_enum`).
- **Decrypted views:** `supabase/migrations/20260419000005_vault_setup.sql` lines 160-198.
- **Existing patterns to reuse:** `src/features/member/api/useMembers.ts` (parallel-queries + Zod-parse), `src/features/member/ui/MemberCard.tsx` (already-interactive variant), `src/features/member/api/memberInitials.ts`, `src/features/member/api/formatAmount.ts`, `src/components/domain/StatusBadge.tsx`, `src/features/cycle/ui/CycleProgressBar.tsx`.
- **Layering rules:** `CLAUDE.md` § Operating principles (layering: domain ← infrastructure ← features ← components).

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
| 2026-04-22 | Winston (architect) | Story 2.4 spec generated by `bmad-create-story`. 13 ACs, 12 tasks. Pure-computation `computeMemberStats` (FR17 formula) lives inline with a TODO(Story 3.2) marker — when Story 3.2 ships the cycle engine domain module, the implementation moves with a 1-file grep. Three-parallel-query hook reuses Story 2.1's `useMembers` pattern. Header + transaction-list split keeps the component testable. Tap-to-receipt is **non-interactive** at MVP — Story 6.7 owns share/re-deliver. Action overflow menu lands as a placeholder so Stories 2.5/2.6/2.7 only flip a `disabled` flag. Status → ready-for-dev. |
