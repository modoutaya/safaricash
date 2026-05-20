// Story 12.2 — calendar-day view builder for the Journal section.
//
// Given a member's transactions for a period + the member's cycle bounds +
// today, emit one row per applicable calendar day in DESCENDING order.
// Days with no transaction emit a `kind='missing'` warning row; days
// covered forward by a multi-day rattrapage are omitted (no duplicate
// row, no warning).
//
// Pure / deterministic / no I/O. `today` is a caller-supplied date so
// tests can pin time without faking `new Date()`.
//
// Spec: _bmad-output/implementation-artifacts/12-2-journal-missing-days.md

import { cycleLengthDays } from "@/domain/cycle";

import type { JournalPeriod } from "./period";
import type { JournalCycleBounds, JournalMember } from "./useJournalMembers";
import type { JournalTransaction } from "./useJournalTransactions";

const MS_PER_DAY = 86_400_000;

export type DayRowKind = "contribution" | "rattrapage" | "advance" | "missing";

export interface DayRow {
  /** YYYY-MM-DD — the calendar date this row represents. */
  date: string;
  /** 1-indexed cycle day for the cycle the row falls under. */
  cycleDay: number;
  /** Cycle id this row is attributed to (lets the consumer key uniquely). */
  cycleId: string;
  kind: DayRowKind;
  /** Present for kind ∈ {contribution, rattrapage, advance}. Absent for missing. */
  tx?: JournalTransaction;
  /** Present for kind='rattrapage' only — how many forward days the
   *  rattrapage covers (passes through `JournalTransaction.daysCovered`). */
  daysCovered?: number;
}

// ---------------------------------------------------------------------------
// Date helpers — UTC-anchored, no Date.now() reads.
// ---------------------------------------------------------------------------

function utcEpoch(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getTime();
}

function isoDateAt(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Inclusive day diff: `(b − a)` in calendar days. */
function dayDiff(aIso: string, bIso: string): number {
  return Math.round((utcEpoch(bIso) - utcEpoch(aIso)) / MS_PER_DAY);
}

/** True iff `date` lies within `[cycle.startDate .. cycle.endDate]` inclusive. */
function dateIsInCycle(dateIso: string, cycle: JournalCycleBounds): boolean {
  return dateIso >= cycle.startDate && dateIso <= cycle.endDate;
}

/** Cycle-day for a calendar date inside the cycle (1-indexed). */
function cycleDayOf(dateIso: string, cycle: JournalCycleBounds): number {
  return dayDiff(cycle.startDate, dateIso) + 1;
}

// ---------------------------------------------------------------------------
// Pure function: build the day rows.
// ---------------------------------------------------------------------------

export interface BuildJournalDayRowsInput {
  transactions: ReadonlyArray<JournalTransaction>;
  period: JournalPeriod;
  member: Pick<JournalMember, "currentCycle" | "previousCycle">;
  /** "today" — the latest calendar date that may appear in the calendar.
   *  YYYY-MM-DD. Pinned so tests are deterministic. */
  todayIso: string;
}

export function buildJournalDayRows(input: BuildJournalDayRowsInput): DayRow[] {
  const { transactions, period, member, todayIso } = input;

  // Step 1 — relevant cycles for the period.
  const cycles: JournalCycleBounds[] = (() => {
    if (period === "cycle_previous") {
      return member.previousCycle ? [member.previousCycle] : [];
    }
    if (period === "cycle_current") {
      return member.currentCycle ? [member.currentCycle] : [];
    }
    // last_seven_days: both cycles may contribute calendar days within
    // the rolling window.
    return [member.currentCycle, member.previousCycle].filter(
      (c): c is JournalCycleBounds => c !== null,
    );
  })();
  if (cycles.length === 0) return [];

  // Step 2 — suppressed cycle-day set (forward coverage from rattrapages).
  // Key: `${cycleId}#${cycleDay}`. A rattrapage at cycle_day=N with
  // days_covered=K suppresses (N+1, …, N+K−1).
  const suppressed = new Set<string>();
  for (const tx of transactions) {
    if (tx.kind !== "rattrapage" || tx.daysCovered === null || tx.daysCovered < 2) continue;
    for (let k = 1; k < tx.daysCovered; k++) {
      suppressed.add(`${tx.cycleId}#${tx.cycleDay + k}`);
    }
  }

  // Step 3 — enumerate candidate calendar dates per period, then for each
  // date find the cycle that owns it.
  const dates: string[] = enumerateDates(period, cycles, todayIso);

  // Index transactions by `${cycleId}#${cycleDay}` for O(1) lookup. A day
  // can in principle have multiple transactions (e.g. contribution + advance);
  // we collect all of them and pick by precedence below.
  const txByKey = new Map<string, JournalTransaction[]>();
  for (const tx of transactions) {
    const key = `${tx.cycleId}#${tx.cycleDay}`;
    const list = txByKey.get(key) ?? [];
    list.push(tx);
    txByKey.set(key, list);
  }

  // Step 4 — emit rows.
  const rows: DayRow[] = [];
  for (const dateIso of dates) {
    const cycle = cycles.find((c) => dateIsInCycle(dateIso, c));
    if (!cycle) continue; // last_seven_days: day outside any cycle.
    const cycleDay = cycleDayOf(dateIso, cycle);
    const cycleLength = cycleLengthDays(cycle.startDate, cycle.endDate);
    // Commission day = last day of cycle. Never a contribution day.
    if (cycleDay === cycleLength) continue;
    // Future days: skip.
    if (dateIso > todayIso) continue;

    const key = `${cycle.id}#${cycleDay}`;
    if (suppressed.has(key)) continue;

    const txs = txByKey.get(key) ?? [];
    const contribution = txs.find((t) => t.kind === "contribution");
    const rattrapage = txs.find((t) => t.kind === "rattrapage");
    const advance = txs.find((t) => t.kind === "advance");

    if (contribution) {
      rows.push({
        date: dateIso,
        cycleDay,
        cycleId: cycle.id,
        kind: "contribution",
        tx: contribution,
      });
    } else if (rattrapage) {
      // Only include daysCovered when present — exactOptionalPropertyTypes
      // rejects `undefined` as a value for an optional property.
      const base: DayRow = {
        date: dateIso,
        cycleDay,
        cycleId: cycle.id,
        kind: "rattrapage",
        tx: rattrapage,
      };
      rows.push(
        rattrapage.daysCovered !== null ? { ...base, daysCovered: rattrapage.daysCovered } : base,
      );
    } else if (advance) {
      rows.push({
        date: dateIso,
        cycleDay,
        cycleId: cycle.id,
        kind: "advance",
        tx: advance,
      });
    } else {
      rows.push({
        date: dateIso,
        cycleDay,
        cycleId: cycle.id,
        kind: "missing",
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Date enumeration per period — descending order. The rendered list ends
// up in the same order without a final sort, by construction.
// ---------------------------------------------------------------------------

function enumerateDates(
  period: JournalPeriod,
  cycles: ReadonlyArray<JournalCycleBounds>,
  todayIso: string,
): string[] {
  if (period === "last_seven_days") {
    // Rolling 7-day window ending today (inclusive).
    const todayMs = utcEpoch(todayIso);
    const out: string[] = [];
    for (let i = 0; i < 7; i++) {
      out.push(isoDateAt(todayMs - i * MS_PER_DAY));
    }
    return out;
  }
  // cycle_previous or cycle_current — only one cycle here per step 1.
  // Iterate from min(today, endDate − 1 day) down to startDate.
  const [cycle] = cycles;
  if (!cycle) return [];
  const cycleLength = cycleLengthDays(cycle.startDate, cycle.endDate);
  // Last contribution day = endDate minus one calendar day (commission day
  // is cycleLength). Use cycle-day arithmetic to keep the math exact.
  const lastContribDateMs = utcEpoch(cycle.startDate) + (cycleLength - 2) * MS_PER_DAY;
  const lastContribDateIso = isoDateAt(lastContribDateMs);
  // Upper bound: today (clamped to last contribution day for previous
  // cycles that have already closed — todayIso > lastContribDateIso so the
  // clamp picks lastContribDate).
  const upperIso = todayIso < lastContribDateIso ? todayIso : lastContribDateIso;
  if (upperIso < cycle.startDate) return [];
  const upperMs = utcEpoch(upperIso);
  const lowerMs = utcEpoch(cycle.startDate);
  const out: string[] = [];
  for (let ms = upperMs; ms >= lowerMs; ms -= MS_PER_DAY) {
    out.push(isoDateAt(ms));
  }
  return out;
}
