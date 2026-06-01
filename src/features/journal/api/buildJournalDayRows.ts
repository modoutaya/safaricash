// Story 12.2 — chronological journal view builder.
//
// Emits one row PER TRANSACTION (contribution, rattrapage, advance) plus
// one `kind='missing'` row per applicable cycle-day that has no transaction
// AND is not forward-covered by a rattrapage. Output is sorted descending
// by calendar date, with createdAt-time as the tiebreaker so multiple
// transactions on the same day appear most-recent-first.
//
// Pre-2026-06: the builder emitted ONE row per cycle-day with a precedence
// pick (contribution > rattrapage > advance), which silently dropped
// rattrapages and advances when another transaction sat on the same day.
// The fix surfaces every transaction the saver actually made — see the
// updated docstring for the visibility contract.
//
// Pure / deterministic / no I/O. `todayIso` is caller-supplied so tests can
// pin time without faking `new Date()`.
//
// Spec: _bmad-output/implementation-artifacts/12-2-journal-missing-days.md

import { cycleLengthDays } from "@/domain/cycle";

import type { JournalPeriod } from "./period";
import type { JournalCycleBounds, JournalMember } from "./useJournalMembers";
import type { JournalTransaction } from "./useJournalTransactions";

const MS_PER_DAY = 86_400_000;

export type DayRowKind = "contribution" | "rattrapage" | "advance" | "missing";

export interface DayRow {
  /** YYYY-MM-DD — the calendar date this row represents. For tx rows this
   *  is the cycle-day-derived date (start_date + cycle_day − 1), not
   *  `tx.created_at`. They match in practice; we prefer the cycle-day
   *  derivation so the row date is consistent with `cycleDay`. */
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

function dayDiff(aIso: string, bIso: string): number {
  return Math.round((utcEpoch(bIso) - utcEpoch(aIso)) / MS_PER_DAY);
}

function dateIsInCycle(dateIso: string, cycle: JournalCycleBounds): boolean {
  return dateIso >= cycle.startDate && dateIso <= cycle.endDate;
}

function cycleDayOf(dateIso: string, cycle: JournalCycleBounds): number {
  return dayDiff(cycle.startDate, dateIso) + 1;
}

function cycleDayToDate(cycle: JournalCycleBounds, cycleDay: number): string {
  return isoDateAt(utcEpoch(cycle.startDate) + (cycleDay - 1) * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Pure function: build the day rows.
// ---------------------------------------------------------------------------

export interface BuildJournalDayRowsInput {
  transactions: ReadonlyArray<JournalTransaction>;
  period: JournalPeriod;
  member: Pick<JournalMember, "currentCycle" | "previousCycle">;
  /** "today" — the latest calendar date that may appear. YYYY-MM-DD. */
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
    return [member.currentCycle, member.previousCycle].filter(
      (c): c is JournalCycleBounds => c !== null,
    );
  })();
  if (cycles.length === 0) return [];

  // Step 2 — suppressed cycle-day set (forward coverage from rattrapages).
  // A rattrapage at cycle_day=N with days_covered=K suppresses (N+1 … N+K−1)
  // from the MISSING-DAY emission only. Real transactions on those days
  // still render — coverage is a "no-warning" signal, not a row censor.
  const suppressed = new Set<string>();
  for (const tx of transactions) {
    if (tx.kind !== "rattrapage" || tx.daysCovered === null || tx.daysCovered < 2) continue;
    for (let k = 1; k < tx.daysCovered; k++) {
      suppressed.add(`${tx.cycleId}#${tx.cycleDay + k}`);
    }
  }

  // Step 3 — enumerate candidate calendar dates per period (for the
  // missing-day emission AND for last_seven_days windowing of tx rows).
  const dates = enumerateDates(period, cycles, todayIso);
  const datesSet = new Set(dates);

  // Step 4 — emit one row per transaction in scope. `settlement` rows are
  // synthetic cycle-close entries (kind set server-side) — never user-facing
  // in the journal, so filtered out here.
  const rows: DayRow[] = [];
  for (const tx of transactions) {
    if (tx.kind !== "contribution" && tx.kind !== "rattrapage" && tx.kind !== "advance") {
      continue;
    }
    const cycle = cycles.find((c) => c.id === tx.cycleId);
    if (!cycle) continue;
    const cycleLength = cycleLengthDays(cycle.startDate, cycle.endDate);
    if (tx.cycleDay < 1 || tx.cycleDay > cycleLength) continue;
    // Commission day never carries a transaction in practice (the server
    // trigger blocks it). Defensive skip.
    if (tx.cycleDay === cycleLength) continue;
    const txDateIso = cycleDayToDate(cycle, tx.cycleDay);
    if (txDateIso > todayIso) continue;
    // last_seven_days: only emit tx rows whose date is in the rolling window.
    if (period === "last_seven_days" && !datesSet.has(txDateIso)) continue;

    const base: DayRow = {
      date: txDateIso,
      cycleDay: tx.cycleDay,
      cycleId: cycle.id,
      kind: tx.kind,
      tx,
    };
    rows.push(
      tx.kind === "rattrapage" && tx.daysCovered !== null
        ? { ...base, daysCovered: tx.daysCovered }
        : base,
    );
  }

  // Step 5 — emit one missing row per (cycle, cycleDay) with NO transaction
  // and not suppressed by a rattrapage.
  const daysWithTx = new Set<string>();
  for (const tx of transactions) {
    daysWithTx.add(`${tx.cycleId}#${tx.cycleDay}`);
  }
  for (const dateIso of dates) {
    const cycle = cycles.find((c) => dateIsInCycle(dateIso, c));
    if (!cycle) continue;
    const cycleDay = cycleDayOf(dateIso, cycle);
    const cycleLength = cycleLengthDays(cycle.startDate, cycle.endDate);
    if (cycleDay === cycleLength) continue;
    if (dateIso > todayIso) continue;
    const key = `${cycle.id}#${cycleDay}`;
    if (suppressed.has(key)) continue;
    if (daysWithTx.has(key)) continue;
    rows.push({
      date: dateIso,
      cycleDay,
      cycleId: cycle.id,
      kind: "missing",
    });
  }

  // Step 6 — sort descending by (date, createdAt time-of-day).
  // Missing rows fall at start-of-day so they sort BEFORE same-date tx rows
  // in ascending order, AFTER them in descending — but tx rows and missing
  // rows never share a date (a date has either ≥1 tx OR is missing, never
  // both), so this only governs intra-tx ordering on a shared date.
  rows.sort((a, b) => {
    const aKey = sortKey(a);
    const bKey = sortKey(b);
    return aKey < bKey ? 1 : aKey > bKey ? -1 : 0;
  });

  return rows;
}

function sortKey(row: DayRow): string {
  if (row.kind === "missing" || row.tx === undefined) {
    return `${row.date}T00:00:00.000Z`;
  }
  const timePart = row.tx.createdAt.slice(10); // "T10:00:00Z" or "T10:00:00.123Z"
  return `${row.date}${timePart}`;
}

// ---------------------------------------------------------------------------
// Date enumeration per period — descending order.
// ---------------------------------------------------------------------------

function enumerateDates(
  period: JournalPeriod,
  cycles: ReadonlyArray<JournalCycleBounds>,
  todayIso: string,
): string[] {
  if (period === "last_seven_days") {
    const todayMs = utcEpoch(todayIso);
    const out: string[] = [];
    for (let i = 0; i < 7; i++) {
      out.push(isoDateAt(todayMs - i * MS_PER_DAY));
    }
    return out;
  }
  const [cycle] = cycles;
  if (!cycle) return [];
  const cycleLength = cycleLengthDays(cycle.startDate, cycle.endDate);
  const lastContribDateMs = utcEpoch(cycle.startDate) + (cycleLength - 2) * MS_PER_DAY;
  const lastContribDateIso = isoDateAt(lastContribDateMs);
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
