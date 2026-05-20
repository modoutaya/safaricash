# Story 12.1: Journal tab — per-member transaction history

Status: draft

## Story

As a **collector**,
I want **a dedicated "Journal" tab that lists each member's transactions for a chosen period, grouped per member, searchable, and paginated**,
so that **I can reconcile a day, a cycle, or a closed cycle without drilling into every member profile one by one.**

## Context

After Epic 9 (Dashboard + Activity Visibility) shipped the global "Activité récente" card on `/dashboard` and the CSV export on `/settings`, the gap remained: there is no in-app, per-member ledger view spanning all members of a collector. The dashboard timeline is global and time-sorted; the member profile shows ONE member at a time; the CSV export dumps everything as a file (not a browsing surface).

At pilot scale a collector handles 300-500 members. Any per-member journal must paginate (default 20) + filter by name + lazy-load each section's transactions to stay responsive on entry-level Android.

The underlying data already exists: `transactions_decrypted` is RLS-scoped to the calling collector and joins to `cycles` + `members_decrypted`. No new RPC, no migration.

## Acceptance Criteria

> Numbered for traceability. The authoritative source for "cycle précédent" is **per-member**: the cycle with `cycle_number = currentCycle.cycle_number − 1` for that member. A member with only one cycle has no previous cycle.

1. **BottomNav — 4th item "Journal".** **Given** the app shell, **When** the user is signed in, **Then** the BottomNav (`src/components/BottomNav.tsx`) renders 4 items in order: `Accueil`, `Membres`, **`Journal`** (new), `Plus`. Icon: `ClipboardList` from `lucide-react`. Active state uses the same green top-border + `text-primary-700` pattern as the existing 3 items. Translation key `nav.journal` = "Journal".

2. **Route `/journal`.** **Given** the protected app routes, **When** the user taps the new tab OR navigates to `/journal`, **Then** they land on a new page rendered by `src/app/routes/journal.tsx`. The page renders inside the existing `AppLayout` (BottomNav sticky at bottom).

3. **Period selector — 3 options, default cycle précédent.** **Given** the Journal page header, **Then** a segmented control offers three options in order:
   - `Cycle précédent` (default — per-member previous cycle)
   - `Cycle en cours` (per-member current cycle)
   - `7 derniers jours` (rolling window: `created_at >= now() − 7 days`)
   The selected period drives the transaction queries below. Selection persists for the current session only (no URL param, no localStorage at MVP).

4. **Member list — 20 default, "Voir plus" pagination.** **Given** the collector has N members (1 ≤ N ≤ 500+ realistic), **When** the Journal page first renders, **Then** the first **20** members appear (sections collapsed), sorted by **most recent activity descending** (most recently transacted member at top). Members with no transaction at all sort last (NULLS LAST). A "Voir plus" button at the bottom loads the next 20. Same client-side pattern as `MemberList` — fetch all members once, sort + slice in JS.

5. **Search input — name filter.** **Given** the Journal page header, **Then** a search input above the member list filters loaded members by `name` (case-insensitive substring match). The filter applies to ALL loaded members (not just the visible 20). When the search text is non-empty the "Voir plus" button is hidden; results show all matches up to a reasonable cap (50). Empty search restores the paginated view.

6. **Per-member section — collapsed by default, lazy expand.** **Given** the member-sections list, **Then** each section is a `<details>` (or equivalent collapsible) that is **closed** by default. The section header shows `name` + a count badge `{n} transaction(s)` (the count is fetched cheaply alongside the member list — see AC 8). Tap-to-expand triggers the lazy fetch of that member's transactions for the selected period (`useJournalTransactions(memberId, period)`).

7. **Transaction row — date, kind chip, amount.** **Given** an expanded section, **Then** each transaction renders one row with: `created_at` formatted as `dd MMM HH:mm` (e.g. `25 mai 14:32`), a kind chip (`Cotisation` / `Avance` / `Rattrapage`), and the amount formatted as `{amount} F CFA`. Rows sorted by `created_at` descending. The amount comes from `transactions_decrypted` (RLS-scoped, vault-decrypted). Empty period for a member: row replaced by "Aucune transaction sur cette période."

8. **Data query — single RPC OR direct view.** **Given** the page first renders, **Then** the member list query (`useJournalMembers`) returns each member's `id`, `name`, `currentCycle.{cycle_number, start_date, end_date}`, `previousCycle.{cycle_number, start_date, end_date}` (nullable), AND `last_activity_at` (max of `transactions.created_at` across all the member's transactions, nullable). One query, ≤ 500 rows. The per-member transaction query (`useJournalTransactions`) takes `memberId` + `period` + member's cycle bounds, returns the filtered transactions. Both are direct SELECTs on the RLS-scoped decrypted views — no new RPC.

9. **i18n strings — French.** All new strings live under `journal.*` in `src/i18n/fr.json`. Keys:
   - `journal.title`, `journal.search_placeholder`
   - `journal.period.previous_cycle`, `journal.period.current_cycle`, `journal.period.last_seven_days`
   - `journal.empty_no_members`, `journal.empty_no_transactions`, `journal.empty_no_previous_cycle`
   - `journal.transaction_count_one`, `journal.transaction_count_many`
   - `journal.show_more`, `journal.loading_transactions`

10. **Tests.**
    - Vitest: `JournalMemberSection.test.tsx` (collapsed/expanded states + transaction fetch on expand), `useJournalMembers.test.tsx` (sort + pagination + search filter), period-selector test.
    - Playwright: `tests/e2e/flow-12-journal-tab.spec.ts` — seeds collector + 3 members with mixed transactions across current + previous cycles, navigates to Journal, asserts the default-cycle-previous view, switches period, searches by name, expands a section, verifies row content.
    - Coverage gate: branches ≥ 75% (per project gate, `feedback_run_coverage_locally`).

## Decisions locked in chat (2026-05-20)

| Decision | Value |
|---|---|
| Tab name | **Journal** |
| Grouping | Sections **per member** |
| Default period | **Cycle précédent** (per-member) |
| Period options | 7 derniers jours / cycle en cours / cycle précédent |
| Sections default state | **Collapsed** |
| Page size | **20** members; "Voir plus" for next 20 |
| Sort | **Activité récente** descending |
| Search scope | Loaded members (client-side, name substring) |
| Transaction fetch | **Lazy** — only on section expand |

## Files touched

- **New**
  - `src/app/routes/journal.tsx`
  - `src/features/journal/api/useJournalMembers.ts`
  - `src/features/journal/api/useJournalTransactions.ts`
  - `src/features/journal/ui/JournalPeriodSelector.tsx`
  - `src/features/journal/ui/JournalMemberSection.tsx`
  - `src/features/journal/ui/JournalTransactionRow.tsx`
  - `src/features/journal/ui/JournalPage.tsx`
  - Tests + Playwright spec
- **Modified**
  - `src/components/BottomNav.tsx` — 4th nav item
  - `src/app/router.tsx` (or equivalent) — register `/journal` route
  - `src/i18n/fr.json` — `journal.*` keys + `nav.journal`

## Out of scope (defer)

- **Export from the Journal page** — re-use the existing CSV export under `/settings` (Story 9.3). A future Story 12.2 can add an inline "Exporter ce filtre" button if pilot feedback asks.
- **Multi-language (Wolof / Bambara)** — French only, per the rest of MVP.
- **Server-side search RPC** — defer until 500+ members become slow on client-side filtering (memory note: MemberList already loads ~500 names without issue).
- **Per-section "Marquer comme rapproché" workflow** — Epic 9 reconciliation UX is a separate ask.
- **Cycle-start-on-first-contribution semantic change** — parked from the same 2026-05-20 chat; affects cycle creation (Story 12.x candidate), not this story.

## Risks + rollback

- **Performance on 500 members** — single SELECT with aggregate `max(created_at)`. If slow, drop the activity sort and fall back to alphabetical. Reversible UI tweak.
- **Lazy fetch UX** — first expand has a spinner. Acceptable; alternative (prefetch all transactions for top 20) trades bandwidth for snap. Defer if needed.
- **No new schema / no new RPC** — rollback is "remove the tab + route", no migration to revert.
