// Story 2.4 — pure computation of derived member-profile stats.
//
// Implements FR17: projectedFinalBalance = (daily × 30) − (1 × daily) − Σ(advances)
// = daily × 29 − Σ(advances). The "−1 × daily" term is the collector's
// 1-day commission per cycle. This is THE canonical formula consumed by
// the SMS receipt copy, the settlement ceremony, and this profile view.
// Zero-tolerance per NFR-R3 — kept pure + 100 % unit-tested.
//
// TODO(Story 3.2): move this function to src/domain/cycle/cycleEngine.ts
// when the canonical cycle engine module lands. Callers stay the same.

import type { MemberStats, TransactionRow } from "../types";

const MS_PER_DAY = 86_400_000;
const CYCLE_TOTAL_DAYS = 30;
const COMMISSION_DAYS = 1;

/** 1-indexed cycle day, clamped to [1, 30]. */
function computeCycleDay(startDate: string, now: Date): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const diffDays = Math.floor((now.getTime() - start) / MS_PER_DAY) + 1;
  return Math.min(CYCLE_TOTAL_DAYS, Math.max(1, diffDays));
}

export function computeMemberStats(
  transactions: TransactionRow[],
  member: { dailyAmount: number },
  currentCycle: { startDate: string } | null,
  now: Date = new Date(),
): MemberStats {
  // Sum the transaction amounts by kind. Done in one pass.
  let contributedTotal = 0;
  let outstandingAdvances = 0;
  for (const tx of transactions) {
    if (tx.kind === "contribution" || tx.kind === "rattrapage") {
      contributedTotal += tx.amount;
    } else if (tx.kind === "advance") {
      outstandingAdvances += tx.amount;
    }
  }

  const cycleDay = currentCycle ? computeCycleDay(currentCycle.startDate, now) : 0;
  const daysRemaining = currentCycle ? CYCLE_TOTAL_DAYS - cycleDay : 0;

  // FR17 — never negative; if a collector grants advances exceeding the
  // theoretical max, we still surface a number (likely zero or negative)
  // and let the UI display it; the cycle engine (Story 3.2) will own the
  // overdraft policy.
  const projectedFinalBalance = currentCycle
    ? member.dailyAmount * (CYCLE_TOTAL_DAYS - COMMISSION_DAYS) - outstandingAdvances
    : 0;

  return {
    cycleDay,
    daysRemaining,
    contributedTotal,
    outstandingAdvances,
    projectedFinalBalance,
  };
}
