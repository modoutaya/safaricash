// Story 3.2 — Pure cycle engine.
//
// Single source of truth for cycle math. Implements ADR-004's 8 invariants
// (docs/ADR/004-cycle-invariants.md). Zero infrastructure / framework /
// React imports. Inputs are scalars / readonly arrays of scalars; outputs
// are scalars / records of scalars. Caller supplies `now` for any time-
// dependent helper — INV-7 forbids `Date.now()` reads inside the engine.
//
// FR15 / FR16 / FR17 / NFR-R3 zero-tolerance live here.

const MS_PER_DAY = 86_400_000;

/** Cycle structure (ADR-004 § Context). */
export const CYCLE_TOTAL_DAYS = 30;
export const COMMISSION_DAYS = 1;
export const CONTRIBUTION_DAYS = CYCLE_TOTAL_DAYS - COMMISSION_DAYS;

function sum(xs: ReadonlyArray<number>): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

/**
 * INV-4 — commission is exactly 1 × dailyAmount, always. The collector
 * earns one day's contribution per cycle — never more, never less.
 */
export function commission(dailyAmount: number): number {
  return dailyAmount * COMMISSION_DAYS;
}

/**
 * FR17 — projected final balance.
 *
 *   projected = (dailyAmount × 30) − (1 × dailyAmount) − Σ(advances)
 *             = dailyAmount × 29 − Σ(advances)
 *
 * INV-1 — independent of cycleDay. INV-4 — commission is constant.
 * INV-3 — caller is responsible for capacity check via canAcceptAdvance().
 * Per ADR-004 Q1: returns the raw value (may be negative); UI decides
 * presentation.
 */
export function computeProjectedFinalBalance(dailyAmount: number, advancesSoFar: number): number {
  return dailyAmount * CONTRIBUTION_DAYS - advancesSoFar;
}

/**
 * INV-3 — accept iff Σ(existing) + new ≤ dailyAmount × 29 (i.e., the new
 * advance does not push the projected balance below 0). Strict ≤ at the
 * equality boundary — landing exactly at 0 is allowed.
 */
export function canAcceptAdvance(
  dailyAmount: number,
  existingAdvances: ReadonlyArray<number>,
  newAdvanceAmount: number,
): boolean {
  return sum(existingAdvances) + newAdvanceAmount <= dailyAmount * CONTRIBUTION_DAYS;
}

/**
 * INV-2 / INV-7 — settlement amount.
 *
 * Per ADR-004 INV-2 (NFR-R3 zero-tolerance): for a fully-paid cycle,
 * settle ≡ projected balance at day 30. Implementation MIRRORS
 * computeProjectedFinalBalance to satisfy that property by construction.
 *
 * Note: this function does NOT take `contributions` as an argument. The
 * contractual amount per FR17 is `dailyAmount × 29 − Σ(advances)`,
 * regardless of how many days were actually recorded. Reconciliation
 * between contractual and actual is a Story 7.x concern.
 */
export function settle(dailyAmount: number, advances: ReadonlyArray<number>): number {
  return computeProjectedFinalBalance(dailyAmount, sum(advances));
}

/**
 * INV-5 — clamped to [1, 30].
 * INV-6 — monotonic in real time.
 *
 * Day 1 = startDate. Day 30 = startDate + 29 days. Any `now` before
 * startDate clamps to 1; any `now` after startDate + 29 days clamps to 30.
 *
 * UTC math throughout — DST is invisible to this function.
 */
export function cycleDay(startDate: string, now: Date): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const elapsed = Math.floor((now.getTime() - start) / MS_PER_DAY) + 1;
  return Math.min(CYCLE_TOTAL_DAYS, Math.max(1, elapsed));
}

/**
 * Per ADR-004 Q2: `settle()` accepts any inputs (no day-30 gate). This
 * separate predicate gates the actual settlement WRITE at the future
 * Edge Function layer (Story 7.x). True iff the cycle has reached day 30.
 */
export function isSettlementReady(now: Date, startDate: string): boolean {
  return cycleDay(startDate, now) >= CYCLE_TOTAL_DAYS;
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
  currentCycle: { startDate: string } | null,
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

  const day = currentCycle ? cycleDay(currentCycle.startDate, now) : 0;
  const daysRemaining = currentCycle ? CYCLE_TOTAL_DAYS - day : 0;
  const projectedFinalBalance = currentCycle
    ? computeProjectedFinalBalance(member.dailyAmount, outstandingAdvances)
    : 0;

  return {
    cycleDay: day,
    daysRemaining,
    contributedTotal,
    outstandingAdvances,
    projectedFinalBalance,
  };
}
