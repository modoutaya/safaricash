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

/**
 * ADR-004 § Amendment A1.8 — cycle-end cap. Collectors don't work the
 * 31st of the month, so a cycle's end_date is capped at day 30 even when
 * the calendar month has 31 days. Inert for 28/29/30-day months. Single
 * point of edit; SQL mirror lives in derive_cycle_bounds (Story 11.5).
 */
export const MAX_CYCLE_END_DAY = 30;

/** Internal — last-day-of-month clamped by MAX_CYCLE_END_DAY. */
function cappedMonthEnd(year: number, month0: number): number {
  return Math.min(lastDayOfMonth(year, month0), MAX_CYCLE_END_DAY);
}

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
 * For a requested start date, the cycle's `end_date` is `min(last calendar
 * day of that month, MAX_CYCLE_END_DAY)` — the cap (ADR-004 § A1.8)
 * shortens 31-day months by 1 day; 28/29/30-day months are unaffected. If
 * the residual length is below `MIN_CYCLE_LENGTH_DAYS`, the cycle rolls
 * forward to the next month (start = 1st, end = the same capped value —
 * year-aware: Dec → Jan next year). The derived `cycleLength` is always
 * `≥ MIN_CYCLE_LENGTH_DAYS`.
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

  const monthEnd = cappedMonthEnd(year, month0);
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
    endDate: isoDate(nextYear, nextMonth0, cappedMonthEnd(nextYear, nextMonth0)),
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
 * Story 12.5 PR C — current "to-reverse" balance (NEW MODEL).
 *
 * Renamed from `computeProjectedFinalBalance` because the pre-12.5
 * projection (daily × contributionDays) made no sense under the
 * cotisation-libre model. The saver versés freely; we can't project
 * a final amount, but we CAN report what the collector currently owes
 * if the cycle were settled this instant.
 *
 *   currentBalance = contributedTotal − dailyAmount − Σ(advances) − openingBalance
 *
 * That's identical to settle() — `currentBalance` IS the running
 * settlement amount evaluated at the current moment.
 *
 * Drives the MemberCard / MemberProfile / AdvanceSimulationPanel
 * "Solde à reverser" row. Per ADR-004 Q1: returns the raw value
 * (may be negative when advances + commission exceed contributions);
 * UI decides presentation.
 */
export function computeCurrentBalance(
  contributedTotal: number,
  dailyAmount: number,
  advancesSoFar: number,
  openingBalance: number = 0,
): number {
  return contributedTotal - dailyAmount - advancesSoFar - openingBalance;
}

/**
 * Story 12.5 — advance capacity (NEW MODEL, PR B).
 *
 * The collector never advances more than the saver has versed so far —
 * no lending against the daily-amount "contract" (which doesn't exist
 * under the cotisation-libre model). Capacity is bounded by actual
 * contributions held by the collector, minus advances already disbursed.
 *
 *     allowed iff Σ(existing) + new ≤ contributedTotal
 *
 * Where `contributedTotal` is the sum of (contribution + rattrapage)
 * booked in this cycle so far (undone excluded), i.e. the cash the
 * collector physically holds for this saver.
 *
 * Pre-12.5 signature `canAcceptAdvance(dailyAmount, existing, new,
 * contributionDays, openingBalance)` capped by the projected daily ×
 * contributionDays which over-credited savers who hadn't paid every
 * day yet (the model corrected by Story 12.5 PR A).
 */
export function canAcceptAdvance(
  contributedTotal: number,
  existingAdvances: ReadonlyArray<number>,
  newAdvanceAmount: number,
): boolean {
  return sum(existingAdvances) + newAdvanceAmount <= contributedTotal;
}

/**
 * Story 12.5 — settlement amount (NEW MODEL).
 *
 * BUSINESS MODEL CORRECTION (2026-05-21): `daily_amount` is a UX
 * suggestion / objective, NOT a contractual daily obligation. Savers
 * cotise freely — some days 10 000, some days 3 000, some days 0. The
 * collector pays back what was actually versed minus a fixed commission
 * of `daily_amount` (1 day's worth of suggested savings) minus any
 * mid-cycle advances minus any opening_balance debt carried over.
 *
 *     payout = contributedTotal − dailyAmount − Σ(advances) − openingBalance
 *
 * Where:
 *  - `contributedTotal` = Σ kind ∈ {contribution, rattrapage} amounts
 *    booked in THIS cycle (undone excluded). The actual money the
 *    collector physically holds.
 *  - `dailyAmount` = the collector's commission (1 day's worth, fixed).
 *  - `advances` = mid-cycle prêts already disbursed.
 *  - `openingBalance` = carry-over from the previous unsettled cycle
 *    (≥ 0). Story 12.3 / Phase A. Optional, defaults to 0.
 *
 * The result may be negative — saver owes the collector when advances
 * + commission > contributions. The UI / Edge Function decides how to
 * present that (could become opening_balance of the next cycle).
 *
 * NFR-R3 zero-tolerance: mirrors SQL `commit_cycle_settlement` exactly.
 * Cross-checked by compute-opening-balance.contract.test.ts and the
 * settlement happy-path unit test.
 *
 * Pre-12.5 signature `settle(dailyAmount, advances, contributionDays,
 * openingBalance)` was wrong — it assumed savers always paid the full
 * daily × contributionDays. Migration to the new signature is tracked
 * in PR A of the 12.5 refactor.
 */
export function settle(
  contributedTotal: number,
  dailyAmount: number,
  advances: ReadonlyArray<number>,
  openingBalance: number = 0,
): number {
  return contributedTotal - dailyAmount - sum(advances) - openingBalance;
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
 *  src/features/member/api/computeMemberStats.ts helper. Story 12.3 added
 *  `openingBalance` — the carry-over of unpaid debt from the previous
 *  unsettled cycle (0 when none / first cycle / previous is 'settled'). */
export interface MemberStats {
  cycleDay: number;
  cycleLength: number;
  daysRemaining: number;
  contributedTotal: number;
  outstandingAdvances: number;
  openingBalance: number;
  /** Story 12.5 PR C — was `currentBalance` until 2026-05-22.
   *  Renamed because the pre-12.5 projection (daily × contribDays) no
   *  longer applies in the cotisation-libre model. Now: what the
   *  collector owes the saver RIGHT NOW = contributedTotal − daily
   *  (commission) − advances − opening_balance. Drives the
   *  "Solde à reverser" row across UIs. */
  currentBalance: number;
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
  /** Carry-over from the previous unsettled cycle. Story 12.3 — defaults
   *  to 0 for backward compatibility with call sites that don't yet
   *  thread the value through (legacy + new-member-first-cycle paths). */
  openingBalance: number = 0,
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
      cycleLength: 0,
      daysRemaining: 0,
      contributedTotal,
      outstandingAdvances,
      openingBalance,
      currentBalance: 0,
    };
  }

  const cycleLength = cycleLengthDays(currentCycle.startDate, currentCycle.endDate);
  const day = cycleDay(currentCycle.startDate, currentCycle.endDate, now);

  return {
    cycleDay: day,
    cycleLength,
    daysRemaining: daysUntilCycleEnd(day, cycleLength),
    contributedTotal,
    outstandingAdvances,
    openingBalance,
    currentBalance: computeCurrentBalance(
      contributedTotal,
      member.dailyAmount,
      outstandingAdvances,
      openingBalance,
    ),
  };
}

// ---------------------------------------------------------------------------
// Story 12.3 — opening_balance carry-over (TS mirror of SQL helper
// public.compute_opening_balance). Recursive on the chain of unsettled
// previous cycles. Same algorithm, same return value (≥ 0). Cross-checked
// by compute-opening-balance.contract.test.ts.
// ---------------------------------------------------------------------------

/** Shape consumed by computeOpeningBalance — a minimal cycle record. The
 *  caller (useMembers / useMemberProfile) already loads these rows. */
export interface OpeningBalanceCycle {
  id: string;
  cycleNumber: number;
  startDate: string;
  endDate: string;
  status: "active" | "with_advance" | "completed" | "settled";
}

/**
 * Story 12.3 — opening_balance(cycle) returns the unpaid debt of the
 * previous unsettled cycle (0 when none). Recursion bottoms out at:
 *   - cycle is the first cycle of the member (cycle_number = 1), OR
 *   - the previous cycle's status is 'settled' (the chain restarts).
 *
 * Pure / deterministic. The caller passes:
 *   - `cycles`: ALL cycles of the member (the recursion walks the chain
 *     backward via cycle_number − 1; cycles outside the chain are
 *     ignored). Order doesn't matter.
 *   - `advancesByCycleId`: a Map<cycleId, Σ(advances excluding undone)>
 *     — the caller is responsible for the exclusion. Missing entries
 *     default to 0.
 *   - `dailyAmount`: the member's daily contribution amount (constant
 *     across cycles per current schema — if this ever changes, this
 *     helper must take a per-cycle daily amount).
 *   - `cycleId`: the cycle whose opening_balance we want.
 *
 * Returns: ≥ 0. Positive = debt carried over. Zero = no carry-over.
 */
export function computeOpeningBalance(
  cycles: ReadonlyArray<OpeningBalanceCycle>,
  advancesByCycleId: ReadonlyMap<string, number>,
  dailyAmount: number,
  cycleId: string,
): number {
  const current = cycles.find((c) => c.id === cycleId);
  if (!current || current.cycleNumber <= 1) return 0;

  const prev = cycles.find((c) => c.cycleNumber === current.cycleNumber - 1);
  if (!prev) return 0;
  if (prev.status === "settled") return 0;

  const prevAdvances = advancesByCycleId.get(prev.id) ?? 0;
  const prevOpening = computeOpeningBalance(cycles, advancesByCycleId, dailyAmount, prev.id);
  const prevContribDays = cycleLengthDays(prev.startDate, prev.endDate) - 1;
  const prevBalance = dailyAmount * prevContribDays - prevAdvances - prevOpening;

  return prevBalance >= 0 ? 0 : -prevBalance;
}
