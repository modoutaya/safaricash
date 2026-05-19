// Story 3.2 — Pure cycle engine.
// Story 11.2 — variable-length (calendar-month) cycles.
//
// Single source of truth for cycle math. Implements ADR-004's invariants
// (docs/ADR/004-cycle-invariants.md), as amended by § Amendment A1 for
// variable-length calendar-month cycles. Zero infrastructure / framework /
// React imports. Inputs are scalars / readonly arrays of scalars; outputs
// are scalars / records of scalars. Caller supplies `now` for any time-
// dependent helper — INV-7 forbids `Date.now()` reads inside the engine.
//
// FR15 / FR16 / FR17 / NFR-R3 zero-tolerance live here.
//
// A cycle spans [start_date, end_date] inclusive. `cycleLength` is derived
// per-cycle from those two dates — the engine no longer assumes 30 days.
// `contributionDays` is always `cycleLength − 1` (one day is the
// collector's commission, ADR-004 INV-4).

const MS_PER_DAY = 86_400_000;

/** ADR-004 INV-4 — commission is exactly 1 day, always (never prorated). */
export const COMMISSION_DAYS = 1;

/**
 * ADR-004 § Amendment A1.5 — roll-forward threshold. A cycle whose
 * calendar-month residual is shorter than this rolls forward to the next
 * month. Product-tunable (Amendment A1-Q1); single point of edit.
 */
export const MIN_CYCLE_LENGTH_DAYS = 3;

function sum(xs: ReadonlyArray<number>): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

/** Parse a YYYY-MM-DD date string as a UTC-midnight epoch. */
function utcEpoch(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getTime();
}

/** Format a UTC year/0-indexed-month/day triple as YYYY-MM-DD. */
function isoDate(year: number, month0: number, day: number): string {
  const mm = String(month0 + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Last calendar day (1-based) of the given UTC year + 0-indexed month. */
function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Inclusive day count of a cycle: `end_date − start_date + 1`. UTC math —
 * DST is invisible. ADR-004 § Amendment A1: replaces the fixed
 * `CYCLE_TOTAL_DAYS = 30` constant.
 */
export function cycleLengthDays(startDate: string, endDate: string): number {
  return Math.round((utcEpoch(endDate) - utcEpoch(startDate)) / MS_PER_DAY) + 1;
}

/**
 * INV-9 — cycle-bounds derivation (write-path invariant).
 *
 * For a requested start date, the cycle's `end_date` is the last calendar
 * day of that month. If the residual length is below
 * `MIN_CYCLE_LENGTH_DAYS`, the cycle rolls forward to the next month
 * (start = 1st, end = its last day — year-aware: Dec → Jan next year).
 * The derived `cycleLength` is always `≥ MIN_CYCLE_LENGTH_DAYS`.
 *
 * This is the canonical reference implementation; Story 11.3's SQL RPCs
 * mirror it and cross-check against it.
 */
export function deriveCycleBounds(requestedDate: string): {
  startDate: string;
  endDate: string;
} {
  const d = new Date(`${requestedDate}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month0 = d.getUTCMonth();
  const day = d.getUTCDate();

  const monthEnd = lastDayOfMonth(year, month0);
  const rawLen = monthEnd - day + 1;

  if (rawLen >= MIN_CYCLE_LENGTH_DAYS) {
    return {
      startDate: isoDate(year, month0, day),
      endDate: isoDate(year, month0, monthEnd),
    };
  }

  // Roll forward to the 1st of the next month (year-aware).
  const nextYear = month0 === 11 ? year + 1 : year;
  const nextMonth0 = (month0 + 1) % 12;
  return {
    startDate: isoDate(nextYear, nextMonth0, 1),
    endDate: isoDate(nextYear, nextMonth0, lastDayOfMonth(nextYear, nextMonth0)),
  };
}

/**
 * INV-4 — commission is exactly 1 × dailyAmount, always. The collector
 * earns one day's contribution per cycle — never more, never less, never
 * prorated to the cycle length (a partial cycle still takes a full day).
 */
export function commission(dailyAmount: number): number {
  return dailyAmount * COMMISSION_DAYS;
}

/**
 * FR17 — projected final balance.
 *
 *   projected = dailyAmount × contributionDays − Σ(advances)
 *
 * where `contributionDays = cycleLength − 1` (the −1 is the commission
 * day, INV-4). INV-1 — independent of cycleDay. Per ADR-004 Q1: returns
 * the raw value (may be negative); UI decides presentation.
 */
export function computeProjectedFinalBalance(
  dailyAmount: number,
  advancesSoFar: number,
  contributionDays: number,
): number {
  return dailyAmount * contributionDays - advancesSoFar;
}

/**
 * INV-3 — accept iff Σ(existing) + new ≤ dailyAmount × contributionDays
 * (i.e., the new advance does not push the projected balance below 0).
 * Strict ≤ at the equality boundary — landing exactly at 0 is allowed.
 */
export function canAcceptAdvance(
  dailyAmount: number,
  existingAdvances: ReadonlyArray<number>,
  newAdvanceAmount: number,
  contributionDays: number,
): boolean {
  return sum(existingAdvances) + newAdvanceAmount <= dailyAmount * contributionDays;
}

/**
 * INV-2 / INV-7 — settlement amount.
 *
 * Per ADR-004 INV-2 (NFR-R3 zero-tolerance): for a fully-paid cycle,
 * settle ≡ projected balance at the cycle's last day. Implementation
 * MIRRORS computeProjectedFinalBalance to satisfy that by construction.
 *
 * The contractual amount per FR17 is `dailyAmount × contributionDays −
 * Σ(advances)`, regardless of how many days were actually recorded.
 */
export function settle(
  dailyAmount: number,
  advances: ReadonlyArray<number>,
  contributionDays: number,
): number {
  return computeProjectedFinalBalance(dailyAmount, sum(advances), contributionDays);
}

/**
 * INV-5 — clamped to [1, cycleLength].
 * INV-6 — monotonic in real time.
 *
 * Day 1 = startDate. Day `cycleLength` = endDate. Any `now` before
 * startDate clamps to 1; any `now` after endDate clamps to `cycleLength`.
 * `cycleLength` is derived internally from start/end — never a parameter.
 *
 * UTC math throughout — DST is invisible to this function.
 */
export function cycleDay(startDate: string, endDate: string, now: Date): number {
  const cycleLength = cycleLengthDays(startDate, endDate);
  const elapsed = Math.floor((now.getTime() - utcEpoch(startDate)) / MS_PER_DAY) + 1;
  return Math.min(cycleLength, Math.max(1, elapsed));
}

/**
 * Per ADR-004 Q2: `settle()` accepts any inputs (no end-date gate). This
 * separate predicate gates the actual settlement WRITE at the Edge
 * Function layer (Story 7.x). True iff `now` is on or after the cycle's
 * last day (`endDate`).
 */
export function isSettlementReady(now: Date, endDate: string): boolean {
  return now.getTime() >= utcEpoch(endDate);
}

/**
 * Story 3.4 / FR19 — true iff new transactions cannot be recorded against
 * the cycle (status is `completed` or `settled`). Mirrors the server-side
 * BEFORE INSERT trigger from migration 0022. Story 4.1's MemberActionSheet
 * consumes this to disable the Primary CTA on closed cycles.
 *
 * `null` cycle (rare; manual data state) → false (no transactions to reject;
 * the absence is itself a different gate handled upstream).
 */
type CycleStatusValue = "active" | "with_advance" | "completed" | "settled";
export function isCycleClosedForTransactions(cycle: { status: CycleStatusValue } | null): boolean {
  if (cycle === null) return false;
  return cycle.status === "completed" || cycle.status === "settled";
}

/**
 * Story 3.5 / FR20 — default upcoming-end window for the dashboard alert.
 * Single point of edit per AC #1 ("configurable" satisfied by the named
 * constant; no env-var / RPC parameter at MVP).
 */
export const DEFAULT_CYCLE_ENDING_WINDOW_DAYS = 7;

/**
 * Story 4.4 / FR23 — discrete N-day rattrapage options surfaced on the
 * member action sheet's long-press / secondary-link reveal. Pinned at
 * [2, 3, 4] per BDD line 857. UX preference, not a domain math invariant
 * — but lives in the cycle-engine module to keep the inline grid tied to
 * the same source of truth as the cycle math.
 */
export const RATTRAPAGE_DAY_OPTIONS = [2, 3, 4] as const;

/**
 * Story 3.5 — days remaining in the cycle for a given 1-indexed day. Pure
 * scalar in/out (INV-7 — no `Date.now()` reads). Clamps to ≥ 0 so that
 * defensive callers passing day > cycleLength don't yield negatives.
 */
export function daysUntilCycleEnd(cycleDayValue: number, cycleLength: number): number {
  return Math.max(0, cycleLength - cycleDayValue);
}

/**
 * Story 3.5 — true iff the cycle's current day puts it within `windowDays`
 * of completion (inclusive of the last day / 0 days remaining — a cycle on
 * its last calendar day is still "ending soon" until Story 3.3's status
 * trigger flips it to `completed`).
 */
export function isCycleInUpcomingEndWindow(
  cycleDayValue: number,
  windowDays: number,
  cycleLength: number,
): boolean {
  return daysUntilCycleEnd(cycleDayValue, cycleLength) <= windowDays;
}

/** Pure derived stats per FR17. Replaces the Story 2.4
 *  src/features/member/api/computeMemberStats.ts helper. */
export interface MemberStats {
  cycleDay: number;
  daysRemaining: number;
  contributedTotal: number;
  outstandingAdvances: number;
  projectedFinalBalance: number;
}

export interface MemberStatsTransaction {
  kind: "contribution" | "rattrapage" | "advance";
  amount: number;
}

export function computeMemberStats(
  transactions: ReadonlyArray<MemberStatsTransaction>,
  member: { dailyAmount: number },
  currentCycle: { startDate: string; endDate: string } | null,
  now: Date = new Date(),
): MemberStats {
  let contributedTotal = 0;
  let outstandingAdvances = 0;
  for (const tx of transactions) {
    if (tx.kind === "contribution" || tx.kind === "rattrapage") {
      contributedTotal += tx.amount;
    } else {
      outstandingAdvances += tx.amount;
    }
  }

  if (currentCycle === null) {
    return {
      cycleDay: 0,
      daysRemaining: 0,
      contributedTotal,
      outstandingAdvances,
      projectedFinalBalance: 0,
    };
  }

  const cycleLength = cycleLengthDays(currentCycle.startDate, currentCycle.endDate);
  const day = cycleDay(currentCycle.startDate, currentCycle.endDate, now);

  return {
    cycleDay: day,
    daysRemaining: daysUntilCycleEnd(day, cycleLength),
    contributedTotal,
    outstandingAdvances,
    projectedFinalBalance: computeProjectedFinalBalance(
      member.dailyAmount,
      outstandingAdvances,
      cycleLength - 1,
    ),
  };
}
