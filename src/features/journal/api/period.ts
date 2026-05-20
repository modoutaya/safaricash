// Story 12.1 — Journal period model.
//
// Three exhaustive options. "cycle_previous" / "cycle_current" are
// per-member (each member has its own cycle bounds); "last_two_days" is
// a rolling time window common to all members.

import type { JournalCycleBounds } from "./useJournalMembers";

export type JournalPeriod = "cycle_previous" | "cycle_current" | "last_two_days";

export const JOURNAL_PERIODS: ReadonlyArray<JournalPeriod> = [
  "cycle_previous",
  "cycle_current",
  "last_two_days",
];

export const DEFAULT_JOURNAL_PERIOD: JournalPeriod = "cycle_previous";

/** Resolve the `[from, to]` window for the per-member period filter.
 *  Returns null when the period is not applicable to this member (e.g.
 *  "cycle_previous" with no previous cycle on file). */
export function resolveJournalPeriodBounds(
  period: JournalPeriod,
  member: { currentCycle: JournalCycleBounds | null; previousCycle: JournalCycleBounds | null },
  now: Date = new Date(),
): { fromIso: string; toIso: string } | null {
  if (period === "last_two_days") {
    // 2 days = the rolling 48-hour window ending now. Inclusive lower bound.
    const fromMs = now.getTime() - 2 * 24 * 60 * 60 * 1000;
    return { fromIso: new Date(fromMs).toISOString(), toIso: now.toISOString() };
  }
  if (period === "cycle_current") {
    if (!member.currentCycle) return null;
    return {
      fromIso: `${member.currentCycle.startDate}T00:00:00Z`,
      toIso: `${member.currentCycle.endDate}T23:59:59.999Z`,
    };
  }
  // cycle_previous
  if (!member.previousCycle) return null;
  return {
    fromIso: `${member.previousCycle.startDate}T00:00:00Z`,
    toIso: `${member.previousCycle.endDate}T23:59:59.999Z`,
  };
}
