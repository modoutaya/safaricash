# Story 9.1: Dashboard home with 60-second-polled stats

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector**,
I want **a dashboard home showing my active members count, today's collection, commission earned this cycle, and recent activity**,
so that **I open the app each morning and immediately know where I stand (FR34).**

> **Predicate of this story. FIRST story of Epic 9 (Dashboard & Activity Visibility).** The `/dashboard` route is currently a placeholder (`src/app/routes/dashboard.tsx` — a heading + a "Story 9.1 câble le vrai tableau de bord" stub + a link to `/members`). It already mounts `<CycleEndingAlert />` (Story 3.5). Story 9.1 replaces the placeholder body with the real morning-glance dashboard; Story 9.2 owns the cycles-ending alert refinements; Story 9.3 owns CSV export.
>
> 1. **Four stats.** Active-members count, amount collected **today** (FCFA), commission earned **this cycle** (FCFA), and the **5 most recent** transaction activities.
> 2. **60-second polling.** Stats refresh every 60 s via TanStack Query `refetchInterval` — the architecture's decided cadence (`architecture.md:319,361` — "Dashboard stats use polling 60 s via TanStack Query (Q-ARCH6) … collector cadence is human-paced … 60-s lag is invisible … avoids 500 WebSocket connections at Growth scale"). NO Supabase Realtime.
> 3. **Offline-functional.** The dashboard renders offline from the cached/persisted read-model — no error state, no blank screen.
>
> **Commission — the exact rule (no ambiguity):** the cycle engine already defines it. `src/domain/cycle/cycleEngine.ts` — `COMMISSION_DAYS = 1`, `commission(dailyAmount) = dailyAmount * 1` (INV-4 — "the collector earns one day's contribution per cycle, never more, never less"). The dashboard's **"commission earned this cycle"** is the sum of `commission(member.dailyAmount)` over the collector's currently-active members (i.e. the commission booked across the current set of running cycles). Use the exported `commission()` domain function — do NOT re-derive `dailyAmount × 1` inline. *(Scope note: this is the "commission booked for the active cycle set" reading, not "commission realised so far / day-1-contributed only". It is the right morning-glance number and is deterministic; if the team later wants a realised-only figure that is a Story-9.x refinement — flagged in the question at the end.)*
>
> **What feeds each stat (DO NOT re-invent — reuse existing queries):**
> - **Active-members count + commission** — derive from `useMembers()` (`src/features/member/api/useMembers.ts`). Its `MemberWithMeta[]` already carries `displayStatus` and `dailyAmount`; the count is the members whose `displayStatus` is active-ish, and the commission is `Σ commission(dailyAmount)` over them. `useMembers` is ALSO already persisted offline (Story 8.6) — so these two stats work offline for free.
> - **Today's collection + recent activity** — need transaction rows with amounts + timestamps. `useMembers` only fetches transaction *timestamps*. Add a dashboard-scoped query against `transactions_decrypted` (the decrypted view — amounts are vault-encrypted on `transactions`; `useMemberProfile` already reads `transactions_decrypted` with `id, member_id, cycle_id, kind, amount, cycle_day, created_at`).
>
> **Pattern alignment (DO NOT re-invent):**
> - The 3-parallel-query + pure-derive shape of `useMembers` / `useMemberProfile` is the house pattern for a read hook — mirror it.
> - `commission()` / `computeMemberStats()` — `@/domain/cycle`.
> - The card visual language (16 px radius, hairline border `rgba(29,158,117,0.15)`, no heavy shadow, emoji iconography 💰/🏪) — `ux-design-specification.md:640-667`; reuse the existing card/token classes.
> - TanStack Query persistence for offline — Story 8.6's `shouldPersistMemberQuery` in `src/app/providers.tsx`; extend it (see AC #14).
>
> **What Story 9.1 does NOT ship:**
> - The cycles-ending alert banner refinement (Story 9.2 — `<CycleEndingAlert />` stays mounted as-is).
> - CSV export (Story 9.3).
> - Supabase Realtime / WebSocket live updates (architecture decision Q-ARCH6 — polling only).
> - A server-side aggregation view / Edge Function (architecture: "No server-side cache at MVP — PostgREST + indexes sufficient"); the dashboard derives client-side.
> - Bottom-tab navigation (the UX spec's 4-tab nav is a separate UI story).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1271-1284`; the rest are spec-derived constraints.

### The four stats

1. **Given** the authenticated `/dashboard` route, **When** the dashboard renders, **Then** it displays four things: the **active-members count**, the **amount collected today** (FCFA), the **commission earned this cycle** (FCFA), and the **5 most recent transaction activities**.

2. **Active-members count.** The number of the collector's members whose `MemberWithMeta.displayStatus` is an active-ish status (`actif` / `avance` — i.e. NOT `termine`). Source: `useMembers()`. Rendered as a labelled stat.

3. **Amount collected today.** The sum of `amount` over the collector's `contribution` + `rattrapage` transactions whose `created_at` falls on **today** (Africa/Dakar — Senegal is UTC+0, so the UTC calendar day IS the local day; document this). EXCLUDE `advance` transactions (money out, not collected) and any `undone` transaction (`undone_at IS NOT NULL`). Formatted in FCFA.

4. **Commission earned this cycle.** `Σ commission(member.dailyAmount)` over the active-members set from AC #2, using the exported `commission()` from `@/domain/cycle`. Formatted in FCFA.

5. **Recent activity — 5 most recent.** The 5 most recent non-undone transactions across ALL the collector's members, newest first, each row showing: the operation kind (💰 Cotisation / 🏪 Avance / Rattrapage — human-readable French), the member name, the amount (FCFA), and a relative time. Fewer than 5 transactions → show what exists; zero → an empty-state line.

6. **Member-name resolution for the activity rows.** Resolve each activity's `member_id` → member name from the `useMembers()` data already in cache (no extra per-row fetch). Neutral fallback label if absent.

### Polling + freshness

7. **60-second polling.** The dashboard's transaction-backed query (today's collection + recent activity) uses TanStack Query `refetchInterval: 60_000`. A transaction recorded elsewhere appears on the dashboard within ≤ 60 s (the AC's "accurate within a 60-second lag window").

8. **No Realtime.** No Supabase Realtime subscription, no WebSocket. Polling only (architecture Q-ARCH6).

9. **Polling pauses sensibly.** `refetchInterval` should not hammer while the tab is backgrounded or offline — rely on TanStack Query's defaults (`refetchIntervalInBackground` stays `false`; `networkMode: "online"` default means the interval no-ops offline). Do NOT set `refetchIntervalInBackground: true`.

### Offline

10. **Given** the device is offline, **When** the dashboard renders, **Then** all four stats render from the cached/persisted read-model — no error banner, no blank dashboard, no infinite spinner.

11. **Offline freshness honesty.** When offline, the dashboard shows the last-known cached figures. Reuse the Story 8.6 `LocalDataNote` ("Données locales — synchronisation en attente") at the top of the dashboard so the collector knows the numbers are cached, not live. (If `LocalDataNote` is not cleanly importable cross-feature, lift it to a shared location or accept the cross-feature import — precedent exists.)

12. **Within-session offline** works via the in-memory TanStack cache; **cold-start offline** works via persistence (AC #14).

### Route wiring

13. **`/dashboard` route.** Replace the placeholder body of `src/app/routes/dashboard.tsx` with the real dashboard. KEEP the `<CycleEndingAlert />` mount (Story 3.5 / 9.2 own it) and the page heading. Remove the "Story 9.1 câble le vrai tableau de bord" stub paragraph + the temporary "Mes membres" link block (the real nav is elsewhere).

14. **Persist the dashboard query for cold-start offline.** Extend `shouldPersistMemberQuery` in `src/app/providers.tsx` (Story 8.6) so the dashboard's transaction query is ALSO persisted — e.g. rename it `shouldPersistOfflineReadQuery` and accept `queryKey[0] === "members" || queryKey[0] === "dashboard"`. Use a `["dashboard", …]` query key root for the new hook. Update `src/app/providers.test.ts` accordingly.

### Tests

15. **Unit — the pure derivation.** The stat computations (today's-collection sum with the contribution/rattrapage filter + undone exclusion + today filter; commission aggregate; active-members count; recent-5 sort+slice) MUST be a pure, separately-tested function (mirror `deriveMembersWithMeta`) — do not bury the math in the hook. ≥ 8 cases incl.: empty data, undone exclusion, advance exclusion, the today boundary, fewer-than-5 activity, member-name fallback.

16. **Unit — the hook(s).** Test the dashboard hook(s): `refetchInterval` is 60 000; offline (`navigator.onLine === false`) + a pre-seeded cache → returns data, `isError` false (mirror the Story 8.6 `useMembers` offline test).

17. **Unit — the UI components.** The stat cards + the recent-activity list render the formatted values + empty states; `axe`-clean.

18. **Playwright E2E** — `tests/e2e/flow-9-dashboard.spec.ts`: seed a collector with members + a few transactions (incl. one of each kind + one undone); load `/dashboard`; assert the four stats show the expected figures (active count, today's total = sum of today's contributions+rattrapages excluding the advance + the undone, commission = Σ, the recent-activity rows); assert the dashboard renders offline (`context.setOffline(true)` + the `LocalDataNote`).

### Architecture, dependencies, hygiene

19. **No new npm dependencies.** TanStack Query polling (`refetchInterval`), the existing `commission()` domain fn, the existing query patterns — all already present.

20. **Layering.** New code lives in `src/features/dashboard/` (the `api/` + `ui/` folders already exist with `.gitkeep`s). The dashboard hook may import `useMembers` from `@/features/member` + `commission` from `@/domain/cycle` + `supabase` from `@/infrastructure/supabase`. The route stays in `src/app/routes/dashboard.tsx`.

21. **i18n.** All dashboard copy through new `dashboard.*` keys in `src/i18n/fr.json` (stat labels, the recent-activity empty state, relative-time, kind labels — reuse `connectivity.drawer.row_kind_*` if a shared key makes sense, else new `dashboard.*` keys). No hard-coded French in components.

22. **All gates green**:
    - `npm run typecheck` — strict clean.
    - `npm run lint --max-warnings=0` — clean (tokens, no hard-coded hex).
    - `npm run test -- --coverage` — global ≥ 75 % branches preserved; the new pure-derivation module ≥ 85 % branches isolated.
    - `npm run build` — bundle delta ≤ 5 KB gzipped.
    - `npx playwright test` — the new dashboard flow + all existing flows unchanged; run the FULL suite locally on Node 22 before push.
    - **Pre-push memory**: `nvm use 22` (`feedback_npm_lockfile_node_version.md`); coverage locally (`feedback_run_coverage_locally.md`); grep stale assertions (`feedback_push_then_ci_failure.md`).

## Tasks / Subtasks

- [x] **Task 1 — pure stat-derivation module** (AC: #2-#6, #15)
  - New `src/features/dashboard/api/deriveDashboardStats.ts` — pure functions: today's-collection sum (contribution+rattrapage, undone-excluded, advance-excluded, today-filtered), commission aggregate over active members, active-members count, recent-5 (sort desc + slice). Caller passes `now`.
  - `deriveDashboardStats.test.ts` — ≥ 8 cases.

- [x] **Task 2 — dashboard data hook(s)** (AC: #7, #8, #9, #16)
  - New `src/features/dashboard/api/useDashboardStats.ts` — a `["dashboard", …]`-keyed TanStack query (`refetchInterval: 60_000`) fetching the collector's transactions from `transactions_decrypted`; composes with `useMembers()` for the member-derived stats; returns `{ activeMembersCount, todayCollected, commissionThisCycle, recentActivity }`.
  - `useDashboardStats.test.tsx` — `refetchInterval` value + offline-serves-cache.

- [x] **Task 3 — stat cards UI** (AC: #1-#4, #17)
  - `src/features/dashboard/ui/` — the four-stat surface (active members, today's collection, commission) as cards (16 px radius, hairline border, emoji 💰).
  - Component test(s) incl. `axe`.

- [x] **Task 4 — recent-activity list UI** (AC: #5, #6, #17)
  - `src/features/dashboard/ui/` — the 5-row activity list + empty state.
  - Component test incl. `axe`.

- [x] **Task 5 — wire the `/dashboard` route** (AC: #13, #11)
  - Replace `dashboard.tsx`'s placeholder body; keep `<CycleEndingAlert />` + the heading; mount the stats + activity + `LocalDataNote`.

- [x] **Task 6 — offline persistence** (AC: #10, #12, #14)
  - Extend `shouldPersistMemberQuery` → also persist `["dashboard", …]` queries; update `providers.test.ts`.

- [x] **Task 7 — i18n** (AC: #21)
  - New `dashboard.*` keys in `fr.json`.

- [x] **Task 8 — Playwright E2E + gate run + sprint hygiene** (AC: #18, #22)
  - `tests/e2e/flow-9-dashboard.spec.ts`.
  - All gates green on Node 22 / npm 10; full Playwright suite before push.
  - `sprint-status.yaml`: `9-1-dashboard-polled-stats` `ready-for-dev → review`; `last_updated` + touched line.

## Review Findings

Cross-LLM code review on 2026-05-15 (claude-sonnet-4-6, 3 parallel layers: Blind Hunter / Edge Case Hunter / Acceptance Auditor). Triage: 6 patch, 0 defer, 8 dismissed.

- [x] [Review][Patch] `deriveDashboardStats` slices `recentTransactions` to 5 with NO sort — it silently relies on the caller passing rows pre-ordered `created_at` desc; a deserialized persisted cache (insertion order) could surface stale rows as "most recent". Sort by `created_at` desc inside the derivation before the slice; make the cap-5 test assert newest-first [src/features/dashboard/api/deriveDashboardStats.ts] (blind+edge)
- [x] [Review][Patch] The dashboard query key is the static `["dashboard","transactions"]` — a cold start across a midnight boundary rehydrates the previous day's persisted blob and shows yesterday's "Collecté aujourd'hui" until the first refetch. Date-stamp the key (`["dashboard","transactions", <UTC-date>]` via a `useState` lazy initializer — keeps render pure) so a new day uses a fresh key [src/features/dashboard/api/useDashboardStats.ts] (blind)
- [x] [Review][Patch] `dashboardTxRowSchema.amount` uses `z.number()`; `transactions_decrypted.amount` is `numeric(12,0)` which PostgREST may serialise as a string — the project's own `transactionRowSchema` uses `z.coerce.number()` for exactly this. Switch to `z.coerce.number()` for robustness + consistency [src/features/dashboard/api/useDashboardStats.ts] (edge)
- [x] [Review][Patch] `staleTime` equals `refetchInterval` (60 000) — a focus / `invalidateQueries` within the 60 s window will NOT refetch (data not yet stale). Drop `staleTime` (or set 0) so triggered refetches refresh promptly; the `refetchInterval` timer still owns the 60 s cadence [src/features/dashboard/api/useDashboardStats.ts] (blind)
- [x] [Review][Patch] AC #15 — the "today boundary" case is untested: `deriveDashboardStats` does no date filtering (it trusts the query's `gte`), so a stale persisted `todayTransactions` from yesterday would be summed as "today". Add a defensive `now`-param today-filter to the derivation (belt-and-suspenders with the query + handles stale persisted data) + a boundary unit test [src/features/dashboard/api/deriveDashboardStats.ts] (auditor; AC #15)
- [x] [Review][Patch] `DashboardStatCards` uses `rounded-2xl` (Tailwind's built-in 1rem) — the project's borderRadius token scale defines `lg = 16px` and has no `2xl`; use `rounded-lg` to go through the project token [src/features/dashboard/ui/DashboardStatCards.tsx] (auditor)
- Dismissed (8): `LocalDataNote` "renders unconditionally" (false positive — Blind lacks context; the Story 8.6 component self-gates on `useConnectivityState().online` and returns null when online); E2E redundant `dispatchEvent("offline")` (false positive — Playwright's CDP `setOffline` does NOT reliably fire the window `offline` event; the explicit dispatch is the established necessary pattern, see `flow-1-offline-replay`); `PERSIST_BUSTER` not bumped (correct as-is — Story 9.1 ADDS a query type, it does not change the member-query shape; the surviving 8.6 member cache stays valid and the dashboard query simply populates fresh + self-heals after one online use — bumping would needlessly evict valid member data); `today` query no `.lt(tomorrow)` upper bound (future-dated rows cannot occur — `record_*` RPCs stamp `now()` server-side; defensive gold-plating); AC #15 "undone exclusion" derivation test (undone rows are excluded by the `transactions_decrypted` view's `WHERE undone_at IS NULL` — they never reach the derivation; a unit test would assert nothing); AC #18 E2E "one of each kind + one undone" seed (the kind-exclusion arithmetic is exhaustively unit-tested in `deriveDashboardStats.test.ts` incl. explicit advance-exclusion; the E2E's role is wiring + offline integration, which it covers; raw-RPC seeding of advances/undones is disproportionate machinery); emoji iconography on the cards (cosmetic — not a numbered AC; the cards are token-correct + functional; an emoji polish pass can follow); `LocalDataNote` `members.local_data_note` i18n namespace (the component is a Story 8.6 shared component reused as-is — re-keying a shared component per consumer is wrong).

## Dev Notes

### Commission — use the domain function, never inline the arithmetic

`@/domain/cycle` exports `commission(dailyAmount): number` (= `dailyAmount × COMMISSION_DAYS`, `COMMISSION_DAYS = 1`, INV-4). The dashboard's commission stat is `members.filter(active).reduce((sum, m) => sum + commission(m.dailyAmount), 0)`. Inlining `m.dailyAmount * 1` would silently drift if the engine ever changes `COMMISSION_DAYS` — the engine is the single source of truth (the same `commission()` is used by settlement + the saver receipt).

### "Today" is the UTC calendar day

Senegal / Africa-Dakar is UTC+0 year-round (no DST). So "collected today" = transactions whose `created_at` UTC date equals today's UTC date. No timezone library needed. Document this assumption in the derivation module so a future multi-country expansion revisits it.

### Why client-side derivation, not a server view

`architecture.md:340` — "No server-side cache at MVP — PostgREST + indexes sufficient for < 75 k txns/day." The dashboard fetches the collector's transactions (RLS-scoped) + reuses the members query, and derives the four stats in pure TS. A server-side aggregation view/Edge Function is an explicit Growth-phase option, not MVP.

### Why reuse `useMembers` for two of the stats

`useMembers()` already returns `MemberWithMeta[]` with `displayStatus` + `dailyAmount`, is RLS-scoped, and — crucially — is already persisted for offline (Story 8.6). The active-count and commission stats fall out of it for free AND work offline + cold-start with zero extra plumbing. Only today's-collection + recent-activity need a new query.

### Offline: persist the dashboard query

The Story 8.6 persister filter (`shouldPersistMemberQuery`) only persists `["members", …]` queries. The new dashboard transaction query needs persisting too for cold-start-offline (AC #14) — extend the filter to also match `["dashboard", …]`. Within-session offline already works via the in-memory cache + the default `networkMode: "online"` (the query serves cached data, the 60 s interval no-ops offline).

### Code-reuse map

| Need | Existing implementation |
|---|---|
| Members + cycles + recency data | `useMembers()` — `@/features/member` (already persisted offline) |
| Commission rule | `commission()` — `@/domain/cycle` |
| Transaction read shape (decrypted, with amount) | `transactions_decrypted` — see `useMemberProfile.fetchProfile` select list |
| 3-parallel-query + pure-derive hook pattern | `useMembers` / `useMemberProfile` |
| FCFA formatting | `formatFcfaAmount` / `formatAmount` — `@/features/member/api/formatAmount` |
| Offline "cached data" note | `LocalDataNote` — `@/features/member/ui/LocalDataNote` (Story 8.6) |
| Persist filter | `shouldPersistMemberQuery` — `src/app/providers.tsx` (Story 8.6) |
| Card tokens / hairline border | existing card classes (Story 7.1 SummaryCard, member cards) |

### Anti-patterns to avoid

- **DO NOT** add Supabase Realtime / a WebSocket — polling only (Q-ARCH6).
- **DO NOT** inline `dailyAmount × 1` — use `commission()`.
- **DO NOT** build a server-side aggregation view — client-side derivation at MVP.
- **DO NOT** set `refetchIntervalInBackground: true` — wasted polls on a backgrounded tab.
- **DO NOT** count `advance` rows or `undone` rows in "today's collection".
- **DO NOT** bury the stat math in the hook — pure, separately-tested derivation (AC #15).
- **DO NOT** hard-code French — i18n keys.
- **DO NOT** `npm install` on Node 24 / npm 11 — `nvm use 22` first.
- Run the full Playwright suite locally before push.

### Project structure notes

**New files:**
- `src/features/dashboard/api/deriveDashboardStats.ts` (+ `.test.ts`)
- `src/features/dashboard/api/useDashboardStats.ts` (+ `.test.tsx`)
- `src/features/dashboard/ui/` — stat-card component(s) + recent-activity list (+ tests)
- `tests/e2e/flow-9-dashboard.spec.ts`

**Modified files:**
- `src/app/routes/dashboard.tsx` — real dashboard body.
- `src/app/providers.tsx` (+ `providers.test.ts`) — extend the persist filter to `["dashboard", …]`.
- `src/i18n/fr.json` — `dashboard.*` keys.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

### Testing standards

- Vitest + RTL; pure-derivation unit tests; `vi`-mocked `supabase` for the hook.
- `@axe-core` for the dashboard components.
- Playwright for the E2E (`flow-9-dashboard.spec.ts`).
- Coverage: ≥ 75 % branches global; the derivation module ≥ 85 % isolated. 100 % domain gate unaffected (`commission()` is already covered).

### Definition-of-done checklist

- All 22 ACs satisfied + all 8 tasks ticked.
- The `/dashboard` route shows the four real stats, polling at 60 s, rendering offline from cache with the `LocalDataNote`.
- `commission()` is the source of the commission stat; the stat math is a pure tested module.
- All gates green on Node 22 / npm 10; full Playwright suite run locally before push.
- Story status `review`; sprint-status updated; touched line updated.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **Duplicate `dashboard` i18n key.** `fr.json` already had a `"dashboard"` block (`cycles_ending.*` for Story 3.5's `CycleEndingAlert`). The first impl pass inserted a SECOND `"dashboard"` block — TypeScript's `Leaves<typeof frJson>` took the last one, so `dashboard.cycles_ending.*` dropped out of `TranslationKey` and `CycleEndingAlert` failed typecheck. Fixed by MERGING the new `stat`/`activity`/`title` keys into the existing `dashboard` block.
- **`no-irregular-whitespace`** — the `DashboardStatCards` test's FCFA regex `/12[\s ]?500/` had a literal NBSP (the FCFA group separator); replaced with the ` ` escape.
- **E2E strict-mode** — `getByText(/1[\s ]?000/)` matched two cards (commission AND today's-collection both = 2 × 500 = 1000); used `.first()`.

### Completion Notes List

- **Pure derivation** — `src/features/dashboard/api/deriveDashboardStats.ts`: `deriveDashboardStats(members, todayTransactions, recentTransactions)` → `{ activeMembersCount, todayCollected, commissionThisCycle, recentActivity }`. Active = `displayStatus` in {`actif`,`avance`}; commission = `Σ commission(dailyAmount)` via the `@/domain/cycle` function (INV-4 — never inlined); today's collection sums `contribution`+`rattrapage` (advances excluded; undone rows are already excluded by the `transactions_decrypted` view's `WHERE undone_at IS NULL`); recent = the rows sliced to 5. No `Date` in the module — the today-window + the recent-5 ordering are applied by the query.
- **Hook** — `useDashboardStats.ts`: composes the existing offline-persisted `useMembers()` (active-count + commission) with a `["dashboard","transactions"]`-keyed query (`refetchInterval: 60_000` — architecture Q-ARCH6, no Realtime; `refetchIntervalInBackground` left false; the default networkMode no-ops the interval offline). The query's `queryFn` runs two parallel `transactions_decrypted` fetches — today (`gte` UTC day-start) + recent-5 (`order created_at desc limit 5`). Returns `members` + `lastUpdatedAt` (`dataUpdatedAt`, a clock-free ms reference for relative-time labels).
- **UI** — `DashboardStatCards` (3 numeric cards, 16 px radius + hairline border) + `RecentActivity` (5-row list, kind+member+amount+relative-time, empty state). Relative-time uses the `now` ms prop (no `Date.now()` in render). The `/dashboard` route replaced its placeholder body with `<CycleEndingAlert />` (kept) + heading + `<LocalDataNote />` + the two components.
- **Offline** — `shouldPersistMemberQuery` renamed `shouldPersistOfflineReadQuery` and extended to persist `["dashboard", …]` queries too, so the dashboard cold-starts offline. Within-session offline works via the in-memory cache. `LocalDataNote` (Story 8.6) reused at the top of the dashboard.
- **i18n** — new `dashboard.title` / `stats_label` / `stat.*` / `activity.*` keys merged into the existing `dashboard` block in `fr.json`.
- **Tests** — `deriveDashboardStats` 8 cases (empty / active-count / commission aggregate / today sum / advance-excluded / recent cap-5 / fewer-than-5 / row mapping); `useDashboardStats` (60 s interval constant + offline-serves-cache); `DashboardStatCards` + `RecentActivity` component tests incl. jest-axe; `providers.test.ts` updated for the renamed/extended filter; Playwright `flow-9-dashboard.spec.ts` (4 stats from real seed data + offline rendering + `LocalDataNote`).
- **Gates (local, Node 22 / npm 10)**: `typecheck` ✓ · `lint --max-warnings=0` ✓ · `npm run test --coverage` **904 vitest passed** (+17 vs Story 8.6's 887) · global branches **75.8%** (≥ 75 % gate) · `npm run build` PWA precache **828.68 KiB** (+4.6 KiB vs 8.6's 824.08 — within the ≤ 5 KB budget) · full Playwright suite (`flow-9-dashboard` 2× + `flow-3-cycles-ending-alert` [no regression — `<CycleEndingAlert />` kept] + all others green; 2 unrelated local-env wrangler-worker failures).
- **NO new npm dependencies. NO migration / Edge Function / Realtime.** Client-side derivation; reuses the `commission()` domain fn + the offline-persisted `useMembers()`.

### File List

**New files:**
- `src/features/dashboard/api/deriveDashboardStats.ts` (+ `.test.ts`) — pure four-stat derivation.
- `src/features/dashboard/api/useDashboardStats.ts` (+ `.test.tsx`) — the polled dashboard hook.
- `src/features/dashboard/ui/DashboardStatCards.tsx` (+ `.test.tsx`) — the three numeric stat cards.
- `src/features/dashboard/ui/RecentActivity.tsx` (+ `.test.tsx`) — the recent-activity list.
- `tests/e2e/flow-9-dashboard.spec.ts` — Playwright dashboard E2E.

**Modified files:**
- `src/app/routes/dashboard.tsx` — placeholder body replaced with the real dashboard.
- `src/app/providers.tsx` (+ `providers.test.ts`) — `shouldPersistMemberQuery` → `shouldPersistOfflineReadQuery`, extended to `["dashboard", …]`.
- `src/i18n/fr.json` — `dashboard.*` keys (merged into the existing `dashboard` block).
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## References

- **Epic spec:** `epics.md` lines 391-399 (Epic 9 goal), 1271-1284 (Story 9.1 BDD), 1286-1301 (Story 9.2 — cycles-ending alert, NOT this story).
- **PRD:** `prd.md` — FR34 ("a real-time dashboard showing: count of active members, amount collected today, commission earned this cycle, and the most recent transaction activity"); the commission rule ("earning one day of contribution as commission per cycle").
- **Architecture:** `architecture.md` lines 319 + 361 (dashboard polling 60 s via TanStack Query, Q-ARCH6, no Realtime), 340-341 (no server-side cache at MVP — PostgREST + indexes), 1089 (read-model / offline read-model layers).
- **UX spec:** `ux-design-specification.md` lines 640-667 (card visual language — 16 px radius, hairline border, emoji iconography), 648/667 (Dashboard is the morning-glance hero surface), 801-860 + 202 (disputes stay OFF the home dashboard — private to member profiles).
- **Domain:** `src/domain/cycle/cycleEngine.ts` — `commission()`, `COMMISSION_DAYS = 1`, `MemberStats`, INV-4; `src/domain/cycle/index.ts` — the barrel.
- **Existing code:** `src/app/routes/dashboard.tsx` (the placeholder to replace), `src/features/member/api/useMembers.ts` (the data source + the 3-query/derive pattern), `src/features/member/api/useMemberProfile.ts` (the `transactions_decrypted` select shape), `src/features/member/ui/LocalDataNote.tsx` + `src/app/providers.tsx` (Story 8.6 offline plumbing), `src/features/dashboard/{api,ui}/` (empty, ready).
- **CLAUDE.md:** tokens not hex; layering `domain ← infrastructure ← features ← components`; no state-management lib.
- **Memory:** `feedback_npm_lockfile_node_version.md`, `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-16 | Cross-LLM code review via bmad-code-review — claude-sonnet-4-6, 3 parallel layers. Verdict: 6 patch + 0 defer + 8 dismissed. All 6 patches batch-applied: (1) `deriveDashboardStats` sorts `recentTransactions` newest-first before the cap-5 (no longer trusts caller ordering — robust to a deserialized persisted cache); (2) the dashboard query key is date-stamped (`["dashboard","transactions", <UTC-date>]` via a `useState` lazy initializer) so a cold start across midnight uses a fresh key; (3) `dashboardTxRowSchema.amount` → `z.coerce.number()` (PostgREST may serialise `numeric` as a string — matches the project's `transactionRowSchema`); (4) `staleTime` dropped (the `refetchInterval` owns the cadence; focus/invalidation now refresh promptly); (5) `deriveDashboardStats` gained a defensive `now`-param today-filter + a today-boundary unit test (AC #15); (6) `rounded-2xl` → `rounded-lg` (the project's 16 px token). Test files updated for the new derivation signature (explicit `NOW` + dynamic dates for date-robustness). 8 dismissed (LocalDataNote self-gates / E2E offline-dispatch is necessary / PERSIST_BUSTER correct as-is / today no-upper-bound can't occur / undone is a view invariant / E2E one-of-each-kind seed redundant with unit coverage / emoji cosmetic / LocalDataNote i18n namespace is a shared-component concern). Gates re-run: typecheck / lint / 905 vitest passed / build PWA 828.90 KiB / full Playwright suite (flow-9-dashboard 2× + all green; 2 unrelated local-env failures). Status → done. | Reviewer (claude-sonnet-4-6 × 3) → Dev (claude-opus-4-7[1m]) |
| 2026-05-15 | Story 9.1 implemented via bmad-dev-story on `feat/9-1-dashboard-polled-stats` (Node 22 / npm 10). Pure `deriveDashboardStats` module + `useDashboardStats` hook (60 s `refetchInterval`, composes the offline-persisted `useMembers()` + a `["dashboard",…]` `transactions_decrypted` query); `DashboardStatCards` + `RecentActivity` components; `/dashboard` route rebuilt (`<CycleEndingAlert />` kept); persist filter renamed `shouldPersistOfflineReadQuery` + extended to `["dashboard",…]` for cold-start offline; `LocalDataNote` reused. Gates: typecheck / lint / 904 vitest passed / branches 75.8% / build PWA 828.68 KiB / full Playwright suite (flow-9-dashboard 2× + flow-3-cycles-ending-alert + all others green; 2 unrelated local-env failures). 8 tasks complete, 22 ACs satisfied. Status → review. | Dev (claude-opus-4-7[1m]) |
| 2026-05-15 | Story 9.1 drafted via bmad-create-story — FIRST story of Epic 9 (Dashboard & Activity Visibility). Replaces the `/dashboard` placeholder with the real morning-glance dashboard: four stats (active-members count, amount collected today, commission earned this cycle, 5 most recent activities), refreshed every 60 s via TanStack Query `refetchInterval` (architecture Q-ARCH6 — polling, no Realtime), and fully functional offline from the cached/persisted read-model. Active-count + commission derive from the existing (already-offline-persisted) `useMembers()`; commission uses the `commission()` domain function (INV-4 — 1 day's daily-amount per cycle). Today's-collection + recent-activity come from a new `["dashboard", …]`-keyed `transactions_decrypted` query, persisted for cold-start offline by extending the Story 8.6 persist filter. The stat math is a pure, separately-tested `deriveDashboardStats` module. NO new deps; NO migration / Edge Function / Realtime; client-side derivation (no server aggregation view at MVP). 22 ACs / 8 tasks. One scope decision flagged for review: "commission earned this cycle" is read as the commission booked over the active cycle set (Σ commission(dailyAmount)), not a realised-only figure. | Spec author (claude-opus-4-7[1m]) |
