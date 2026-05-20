# Story 12.2: Journal — missing-day rows + calendar view

Status: draft

## Story

As a **collector**,
I want **each member's section of the Journal to show one row per calendar day in the chosen period, with a warning marker on days where the member did not contribute**,
so that **I can spot gaps in a member's contribution discipline at a glance, without mentally diffing the transaction list against the cycle calendar.**

## Context

Story 12.1 (PR #125 + #126) shipped the Journal tab as a per-member **transaction list** — one row per row in `transactions_decrypted`. The pilot collector reviewed the live surface and asked for the inverse view: a **calendar of expected contribution days** with an explicit indicator on the empty slots.

Example (pilot's words, 2026-05-20): a member who contributed on days 12, 13, and 17 of the month should produce, in descending order:

- Day 17 — `Cotisation` row
- Day 16 — **missing** row (warning marker)
- Day 15 — **missing** row
- Day 14 — **missing** row
- Day 13 — `Cotisation` row
- Day 12 — `Cotisation` row

## Decisions locked in chat (2026-05-20)

| Decision | Value |
|---|---|
| Rattrapage display | **One row at the day of registration**. A 3-day rattrapage on day 10 covers days 10/11/12; the row at day 10 carries a "3 jours" suffix on the chip. **Days 11 and 12 are NOT in the calendar list** (no duplicate row, no missing-day warning — the rattrapage on day 10 implies forward coverage). |
| Future days | **Not shown.** Cycle-en-cours calendar starts at the earliest applicable day and ends at "today". No "à venir" placeholders. |
| `7 derniers jours` semantics | **Same missing-day logic applies.** Iterate calendar days in the rolling window; for each day, find which of the member's cycles covers it; mark as `Cotisation` / `Rattrapage` / `Avance` / `missing` as relevant. Days that fall outside any cycle on file (e.g. member joined the program 3 days ago — the 4 days before that are "not applicable") are SKIPPED, not warned. |

## Acceptance Criteria

> Numbered for traceability. The authoritative source for cycle bounds is the cycle row's `(start_date, end_date)` pair; cycle-day for a calendar date is `(date − start_date) + 1`.

1. **New pure function `buildJournalDayRows`.** Given a member's transactions for a period, the period bounds, the member's current+previous cycle (nullable), and `today` (date), the function returns an array of `DayRow` objects in **descending calendar order**, each with: `{ date: YYYY-MM-DD, cycleDay: number, cycleId: string, kind: "contribution"|"rattrapage"|"advance"|"missing", tx?: JournalTransaction, daysCovered?: number }`. Pure: deterministic, no I/O, no `Date.now()` reads. Exported and unit-tested.

2. **Period scoping — `cycle_previous` / `cycle_current`.** The function iterates `cycle_day` from `min(today's cycle-day, cycleLength − 1)` (the last past contribution day) down to `1`. Day `cycleLength` (the commission day) is **never** included. Days BEFORE `start_date` or AFTER `today` are never included.

3. **Period scoping — `last_seven_days`.** The function iterates the calendar days in the rolling window from `today` down to `today − 6 days` (7 inclusive days). For each calendar day, it finds the cycle that covers it (matching `start_date ≤ date ≤ end_date − 1` — the commission day is still skipped). Days that don't fall in any cycle are omitted from the output, not warned.

4. **Rattrapage forward-coverage suppression.** When the input transactions contain a `kind='rattrapage'` row at `cycle_day=N` with `days_covered=K`, the row appears in the output at day `N` (with `kind='rattrapage'` + `daysCovered=K`). Days `N+1`, …, `N+K−1` are **omitted from the output** entirely — no missing-day warning, no duplicate row. Coverage is forward (matches the `record_rattrapage` SQL contract `cycle_day + days_covered − 1 ≤ cycleLength`).

5. **Advance precedence.** A day with ONLY an `advance` transaction (no contribution, no rattrapage covering it) emits **one `kind='advance'` row** and NO missing-day warning. Rationale: an advance is still a recorded event on that day; the warning is for "no event on a day where a contribution was expected". Future iteration may refine (e.g. "advance + missing contribution → both signals visible"); MVP keeps it simple.

6. **Multi-transaction day.** If a day has both a contribution AND an advance (unusual but allowed), emit the contribution row only (the advance is visible in the data but not surfaced in the day calendar — defer to the existing member-profile screen for full ledger).

7. **Missing-day row visual.** A new `kind='missing'` row variant renders with `bg-warning-bg` + `text-warning-text` + a `lucide-react` `AlertTriangle` icon. Copy: `"Jour manqué"` headline + the formatted date as the sub-text. No amount on the right side.

8. **Rattrapage chip with day count.** The existing `Rattrapage` chip gains a suffix when `daysCovered > 1`: `"Rattrapage · 3 jours"` (for `daysCovered=3`). Single-day rattrapages (technically forbidden by the RPC — `days_covered ∈ [2,4]`) — defensive: no suffix.

9. **i18n keys (new).**
   - `journal.day_missing_headline` = `"Jour manqué"`
   - `journal.day_missing_sublabel` = `"Aucune cotisation enregistrée"`
   - `journal.kind_rattrapage_days_suffix` = `"· {n} jours"` (interpolated with `daysCovered`)

10. **Tests.**
    - **Vitest unit** (`buildJournalDayRows.test.ts`):
      a. Full cycle with daily contributions → cycle_length − 1 rows, all `contribution`.
      b. Days 12, 13, 17 contributions on a 30-day cycle, today=day 20 → produces the pilot's example (3 contrib + 4 missing + skips 18/19/20 as missing+future).
      c. Rattrapage on day 10 with `days_covered=3` → day 10 emits rattrapage row, days 11/12 omitted, day 9 emits missing.
      d. Advance on day 5 (no contribution) → day 5 is an advance row, no warning.
      e. Commission day never appears.
      f. `last_seven_days` spanning prev+current cycle — cycles split correctly; cycle-less days skipped.
      g. Future days never appear in `cycle_current`.
    - **Vitest UI** (`JournalDayRow.test.tsx`): renders all 4 variants; rattrapage chip carries "· 3 jours" when daysCovered=3.
    - **Existing `JournalMemberSection.test.tsx`** updated: assertions on missing rows, rattrapage suffix.
    - Coverage gate: branches ≥ 75% (per `feedback_run_coverage_locally`).

## Algorithm

```text
input:
  transactions: ReadonlyArray<JournalTransaction & { cycleDay: number; cycleId: string; daysCovered?: number }>
  period: JournalPeriod
  member.currentCycle, member.previousCycle  (each with id, startDate, endDate, cycleNumber)
  todayIso: YYYY-MM-DD

step 1: determine relevant cycles
  if period === "cycle_previous"  → [previousCycle] (skip if null)
  if period === "cycle_current"   → [currentCycle]  (skip if null)
  if period === "last_seven_days" → [currentCycle, previousCycle] (filter nulls)

step 2: compute the suppressed set
  suppressed: Set<`${cycleId}#${cycleDay}`>
  for each rattrapage in transactions:
    for k in 1..(daysCovered−1):
      suppressed.add(`${rattrapage.cycleId}#${rattrapage.cycleDay + k}`)

step 3: for each candidate day in DESC order:
  date = the date in question (depending on period)
  cycle = cycle whose [startDate..endDate−1] contains date
  if no cycle → skip (period=last_seven_days only)
  cycleDay = (date − cycle.startDate) + 1
  if cycleDay === cycleLength(cycle) → skip (commission day)
  if date > todayIso → skip
  key = `${cycle.id}#${cycleDay}`
  if suppressed.has(key) → skip

  txs = transactions where (tx.cycleId === cycle.id && tx.cycleDay === cycleDay)
  if any contribution in txs → push { kind: "contribution", tx: that one }
  else if any rattrapage in txs → push { kind: "rattrapage", tx, daysCovered }
  else if any advance in txs → push { kind: "advance", tx }
  else → push { kind: "missing", date, cycleDay, cycleId }

step 4: return rows (already DESC-sorted by construction)
```

## Files touched

- **New**
  - `src/features/journal/api/buildJournalDayRows.ts`
  - `src/features/journal/api/buildJournalDayRows.test.ts`
  - `src/features/journal/ui/JournalDayRow.tsx` (replaces `JournalTransactionRow.tsx` — kept the export name in the barrel for backward compat OR removed if unused)
  - `src/features/journal/ui/JournalDayRow.test.tsx`
- **Modified**
  - `src/features/journal/ui/JournalMemberSection.tsx` — calls `buildJournalDayRows`
  - `src/features/journal/ui/JournalMemberSection.test.tsx`
  - `src/features/journal/api/useJournalTransactions.ts` — select `cycle_day`, `cycle_id`, `days_covered` columns (not currently selected)
  - `src/i18n/fr.json` — `journal.day_missing_*` + `journal.kind_rattrapage_days_suffix`

## Out of scope (defer)

- **"À venir" placeholders** for future cycle days — deliberately decided NOT to show.
- **Multi-transaction same-day display** (e.g. an advance AND a contribution on the same day) — kept to contribution-only at MVP.
- **Per-day total** at the section header (e.g. "Jour 17: 1 500 F CFA") — defer; current per-row amount is sufficient.
- **Server-side day-aggregate RPC** — defer until 30-day calendars × 500 members surfaces a real perf issue. Current client-side aggregate is O(N) over the loaded transactions.
- **i18n for Wolof / Bambara** — French only.

## Risks + rollback

- **Edge cases in `last_seven_days` spanning cycles** — covered by tests, but worth manual QA on a member who recently restarted a cycle.
- **Performance on a 30-day section for a member with 30 transactions** — 30 day-rows render fast. Tested at 30; ~500 members all expanded would render ~15 000 rows in the worst case, but expansion is lazy + manual — non-issue.
- **Rollback** — purely additive frontend; revert the PR if a UX regression surfaces.
