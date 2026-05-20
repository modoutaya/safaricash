// Story 3.2 — cycle engine tests.
// Story 11.2 — re-parameterized for variable-length (calendar-month) cycles.
//
// 9 property tests via fast-check (one per ADR-004 invariant, INV-1..INV-9)
// + example tests for documentation + boundary coverage. Test names quote
// ADR-004's plain-English statement so failures surface invariant intent
// at the runner's first line.
//
// See: docs/ADR/004-cycle-invariants.md § Amendment A1.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  COMMISSION_DAYS,
  DEFAULT_CYCLE_ENDING_WINDOW_DAYS,
  MIN_CYCLE_LENGTH_DAYS,
  RATTRAPAGE_DAY_OPTIONS,
  canAcceptAdvance,
  commission,
  computeMemberStats,
  computeProjectedFinalBalance,
  cycleDay,
  cycleLengthDays,
  daysUntilCycleEnd,
  deriveCycleBounds,
  isCycleClosedForTransactions,
  isCycleInUpcomingEndWindow,
  isSettlementReady,
  settle,
} from "./cycleEngine";

const sum = (xs: ReadonlyArray<number>): number => xs.reduce((a, b) => a + b, 0);

/** Test-only: add `days` to a YYYY-MM-DD date, returning YYYY-MM-DD. */
function isoDatePlusDays(startDate: string, days: number): string {
  const d = new Date(`${startDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Test-only oracle: a date is the last calendar day of its month iff the
 *  next day is the 1st of some month. Uses `isoDatePlusDays` (setUTCDate)
 *  — a different code path than production `lastDayOfMonth`'s
 *  `Date.UTC(y, m+1, 0)`, so a shared off-by-one in production would not
 *  be hidden by a mirroring test helper. */
function isLastDayOfMonth(isoDate: string): boolean {
  return isoDatePlusDays(isoDate, 1).endsWith("-01");
}

/** Test-only: 1st of the calendar month AFTER the given date (year-aware
 *  via setUTCDate-based arithmetic, independent of production's modulo). */
function firstDayOfNextMonth(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  // Jump deep into the next month then snap to day 1 — avoids any month-
  // length / modulo logic mirroring production.
  d.setUTCDate(1);
  d.setUTCDate(d.getUTCDate() + 40);
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Property tests — one per ADR-004 invariant (INV-1..INV-9, Amendment A1).
// ---------------------------------------------------------------------------

describe("cycleEngine — property tests (ADR-004 invariants)", () => {
  it("INV-1: projected balance depends only on dailyAmount, Σ(advances), contributionDays — not cycleDay (propProjectedBalanceTimeInvariance)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000 }),
        fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 0, maxLength: 31 }),
        (dailyAmount, cycleLength, advances) => {
          const contributionDays = cycleLength - 1;
          // cycleDay is not an input — invariance is structural.
          const a = computeProjectedFinalBalance(dailyAmount, sum(advances), contributionDays);
          const b = computeProjectedFinalBalance(dailyAmount, sum(advances), contributionDays);
          return a === b && a === dailyAmount * contributionDays - sum(advances);
        },
      ),
    );
  });

  it("INV-2: settled balance ≡ projected balance at cycle end for fully-paid cycles (propSettledEqualsProjectedAtCycleEnd)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000 }),
        fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }),
        (dailyAmount, cycleLength) => {
          const contributionDays = cycleLength - 1;
          const settled = settle(dailyAmount, [], contributionDays);
          const projected = computeProjectedFinalBalance(dailyAmount, 0, contributionDays);
          return settled === projected && settled === dailyAmount * contributionDays;
        },
      ),
    );
  });

  it("INV-3: advance request is accepted iff total advances stay within capacity (propAdvanceCapacityBound)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000 }),
        fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 100_000 }),
        (dailyAmount, cycleLength, existing, newAdvance) => {
          const contributionDays = cycleLength - 1;
          const capacity = dailyAmount * contributionDays;
          const expected = sum(existing) + newAdvance <= capacity;
          return canAcceptAdvance(dailyAmount, existing, newAdvance, contributionDays) === expected;
        },
      ),
    );
  });

  it("INV-4: commission is exactly 1 × dailyAmount, regardless of cycle length (propCommissionInvariance)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 100_000 }), (dailyAmount) => {
        return commission(dailyAmount) === dailyAmount;
      }),
    );
  });

  it("INV-5: cycleDay is clamped to [1, cycleLength] (propCycleDayClamped)", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2026-01-01"),
          max: new Date("2026-12-31"),
          noInvalidDate: true,
        }),
        fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }),
        fc.integer({ min: -100, max: 200 }),
        (start, cycleLength, dayOffset) => {
          const startDate = start.toISOString().slice(0, 10);
          const endDate = isoDatePlusDays(startDate, cycleLength - 1);
          const now = new Date(start.getTime() + dayOffset * 86_400_000);
          const day = cycleDay(startDate, endDate, now);
          return day >= 1 && day <= cycleLength;
        },
      ),
    );
  });

  it("INV-6: cycleDay is monotonic in real time (propCycleDayMonotonic)", () => {
    const validDate = fc.date({
      min: new Date("2025-01-01"),
      max: new Date("2027-12-31"),
      noInvalidDate: true,
    });
    fc.assert(
      fc.property(
        validDate,
        fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }),
        validDate,
        validDate,
        (start, cycleLength, t1, t2) => {
          const startDate = start.toISOString().slice(0, 10);
          const endDate = isoDatePlusDays(startDate, cycleLength - 1);
          const [early, late] = t1 < t2 ? [t1, t2] : [t2, t1];
          return cycleDay(startDate, endDate, early) <= cycleDay(startDate, endDate, late);
        },
      ),
    );
  });

  it("INV-7: settle() is referentially transparent (propSettlementDeterministic)", () => {
    fc.assert(
      fc.property(
        fc.record({
          dailyAmount: fc.integer({ min: 100, max: 100_000 }),
          advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
          contributionDays: fc.integer({ min: MIN_CYCLE_LENGTH_DAYS - 1, max: 30 }),
        }),
        (s) => {
          const a = settle(s.dailyAmount, s.advances, s.contributionDays);
          const b = settle(s.dailyAmount, s.advances, s.contributionDays);
          return a === b;
        },
      ),
    );
  });

  it("INV-8: every monetary output is an integer FCFA (propIntegerFcfaOutputs)", () => {
    fc.assert(
      fc.property(
        fc.record({
          dailyAmount: fc.integer({ min: 100, max: 100_000 }),
          advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
          contributionDays: fc.integer({ min: MIN_CYCLE_LENGTH_DAYS - 1, max: 30 }),
        }),
        (s) => {
          const projected = computeProjectedFinalBalance(
            s.dailyAmount,
            sum(s.advances),
            s.contributionDays,
          );
          const settled = settle(s.dailyAmount, s.advances, s.contributionDays);
          const comm = commission(s.dailyAmount);
          return [projected, settled, comm].every(Number.isInteger);
        },
      ),
    );
  });

  it("INV-9: end_date is the month-end of start; short residual rolls forward to the next month; length ≥ MIN (propCycleBoundsDerivation)", () => {
    // Range extended through 2028 to cover leap-year February (29 days).
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2026-01-01"),
          max: new Date("2028-12-31"),
          noInvalidDate: true,
        }),
        (requestedAt) => {
          const requested = requestedAt.toISOString().slice(0, 10);
          const { startDate, endDate } = deriveCycleBounds(requested);
          const length = cycleLengthDays(startDate, endDate);

          // (a) endDate is a month-end (oracle: day-after is the 1st — uses
          //     setUTCDate arithmetic, NOT the production Date.UTC(y,m+1,0)).
          if (!isLastDayOfMonth(endDate)) return false;
          // (b) endDate sits in startDate's year-month (same YYYY-MM prefix).
          if (endDate.slice(0, 7) !== startDate.slice(0, 7)) return false;
          // (c) length respects the MIN floor.
          if (length < MIN_CYCLE_LENGTH_DAYS) return false;
          // (d) startDate is EITHER requested (no roll) OR exactly the 1st of
          //     the month AFTER requested's month — not just some month's 1st.
          if (startDate !== requested && startDate !== firstDayOfNextMonth(requested)) return false;

          return true;
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Example-based tests — concrete values + boundary coverage.
// ---------------------------------------------------------------------------

describe("cycleEngine — example tests", () => {
  describe("cycleLengthDays", () => {
    it("a full 30-day April cycle → 30", () => {
      expect(cycleLengthDays("2026-04-01", "2026-04-30")).toBe(30);
    });

    it("a partial cycle from the 7th → 24 (worked example)", () => {
      expect(cycleLengthDays("2026-04-07", "2026-04-30")).toBe(24);
    });

    it("a 31-day cycle → 31", () => {
      expect(cycleLengthDays("2026-01-01", "2026-01-31")).toBe(31);
    });

    it("a legacy window (start + 29 days) → 30", () => {
      expect(cycleLengthDays("2026-04-03", "2026-05-02")).toBe(30);
    });
  });

  describe("deriveCycleBounds (INV-9)", () => {
    it("worked example — registered the 7th of a 30-day month → [7th, 30th], length 24", () => {
      expect(deriveCycleBounds("2026-04-07")).toEqual({
        startDate: "2026-04-07",
        endDate: "2026-04-30",
      });
      expect(cycleLengthDays("2026-04-07", "2026-04-30")).toBe(24);
    });

    it("registration on the 1st → full calendar month (February 2026, 28 days)", () => {
      expect(deriveCycleBounds("2026-02-01")).toEqual({
        startDate: "2026-02-01",
        endDate: "2026-02-28",
      });
    });

    it("exactly MIN_CYCLE_LENGTH_DAYS residual → NO roll-forward (≥ boundary inclusive)", () => {
      // 2026-04-28 → April ends on the 30th → rawLen = 30−28+1 = 3 = MIN.
      expect(deriveCycleBounds("2026-04-28")).toEqual({
        startDate: "2026-04-28",
        endDate: "2026-04-30",
      });
    });

    it("residual below MIN → roll-forward to the next month", () => {
      // 2026-04-29 → rawLen = 2 < 3 → roll to May.
      expect(deriveCycleBounds("2026-04-29")).toEqual({
        startDate: "2026-05-01",
        endDate: "2026-05-31",
      });
    });

    it("roll-forward across the year boundary — December → January next year", () => {
      // 2026-12-30 → rawLen = 2 < 3 → roll to January 2027.
      expect(deriveCycleBounds("2026-12-30")).toEqual({
        startDate: "2027-01-01",
        endDate: "2027-01-31",
      });
    });

    it("registration on the last day rolls forward (rawLen = 1)", () => {
      expect(deriveCycleBounds("2026-06-30")).toEqual({
        startDate: "2026-07-01",
        endDate: "2026-07-31",
      });
    });

    it("leap-year February — registration on the 1st gives a 29-day cycle (ADR A1.4 boundary)", () => {
      // 2028 is a leap year. February 2028 has 29 days; ending on the 29th
      // is the correct month-end (vs. 28th in a non-leap year).
      expect(deriveCycleBounds("2028-02-01")).toEqual({
        startDate: "2028-02-01",
        endDate: "2028-02-29",
      });
      expect(cycleLengthDays("2028-02-01", "2028-02-29")).toBe(29);
    });

    it("leap-year February — registration on the 27th yields exactly MIN_CYCLE_LENGTH_DAYS (no roll)", () => {
      // 2028-02-27 → rawLen = 29 − 27 + 1 = 3 = MIN → no roll-forward.
      expect(deriveCycleBounds("2028-02-27")).toEqual({
        startDate: "2028-02-27",
        endDate: "2028-02-29",
      });
    });

    it("leap-year February — registration on the 28th rolls forward (rawLen = 2 < 3)", () => {
      // 2028-02-28 → rawLen = 29 − 28 + 1 = 2 < 3 → roll to March 2028.
      expect(deriveCycleBounds("2028-02-28")).toEqual({
        startDate: "2028-03-01",
        endDate: "2028-03-31",
      });
    });
  });

  describe("computeProjectedFinalBalance", () => {
    it("dailyAmount=500, no advances, 29 contribution days → 14_500 (legacy 30-day cycle)", () => {
      expect(computeProjectedFinalBalance(500, 0, 29)).toBe(14_500);
    });

    it("dailyAmount=500, advances=3000, 29 contribution days → 11_500", () => {
      expect(computeProjectedFinalBalance(500, 3000, 29)).toBe(11_500);
    });

    it("worked example — dailyAmount=500, no advances, 23 contribution days → 11_500", () => {
      expect(computeProjectedFinalBalance(500, 0, 23)).toBe(11_500);
    });

    it("returns a negative value when advances exceed capacity (Q1 — raw value)", () => {
      expect(computeProjectedFinalBalance(500, 20_000, 29)).toBe(-5_500);
    });
  });

  describe("settle", () => {
    it("dailyAmount=1000, no advances, 29 contribution days → 29_000 (legacy)", () => {
      expect(settle(1000, [], 29)).toBe(29_000);
    });

    it("dailyAmount=500, advances [3000, 2000], 29 contribution days → 9_500", () => {
      expect(settle(500, [3000, 2000], 29)).toBe(9_500);
    });

    it("legacy equivalence — settle on a 30-day cycle matches the pre-11.2 numbers", () => {
      // A legacy row: cycleLength 30 → contributionDays 29 → identical output.
      const legacyLength = cycleLengthDays("2026-04-01", "2026-04-30");
      expect(settle(500, [], legacyLength - 1)).toBe(14_500);
    });
  });

  describe("commission (INV-4 — unchanged)", () => {
    it("is exactly 1 × dailyAmount", () => {
      expect(commission(500)).toBe(500);
      expect(commission(100_000)).toBe(100_000);
    });

    it("COMMISSION_DAYS is 1", () => {
      expect(COMMISSION_DAYS).toBe(1);
    });
  });

  describe("cycleDay", () => {
    it("returns 15 on day 15 of a 30-day cycle", () => {
      expect(cycleDay("2026-04-01", "2026-04-30", new Date("2026-04-15T12:00:00Z"))).toBe(15);
    });

    it("returns 1 when now is BEFORE startDate (clamped)", () => {
      expect(cycleDay("2026-04-15", "2026-04-30", new Date("2026-04-01T00:00:00Z"))).toBe(1);
    });

    it("clamps to cycleLength when now is after endDate (24-day partial cycle)", () => {
      // start 7th, end 30th → cycleLength 24; now well past → clamps to 24.
      expect(cycleDay("2026-04-07", "2026-04-30", new Date("2026-06-01T12:00:00Z"))).toBe(24);
    });

    it("returns 1 on day 1 (boundary)", () => {
      expect(cycleDay("2026-04-01", "2026-04-30", new Date("2026-04-01T00:00:00Z"))).toBe(1);
    });

    it("returns cycleLength on the last day (boundary)", () => {
      expect(cycleDay("2026-04-01", "2026-04-30", new Date("2026-04-30T23:59:59Z"))).toBe(30);
    });
  });

  describe("canAcceptAdvance", () => {
    it("accepts an advance that exactly hits capacity (29 contribution days)", () => {
      expect(canAcceptAdvance(500, [], 14_500, 29)).toBe(true);
    });

    it("rejects an advance over by 1 FCFA", () => {
      expect(canAcceptAdvance(500, [], 14_501, 29)).toBe(false);
    });

    it("respects existing advances", () => {
      expect(canAcceptAdvance(500, [10_000], 4_500, 29)).toBe(true); // total 14_500 = capacity
      expect(canAcceptAdvance(500, [10_000], 4_501, 29)).toBe(false); // over by 1
    });

    it("capacity shrinks with a shorter partial cycle (23 contribution days)", () => {
      // dailyAmount 500 × 23 = 11_500 capacity.
      expect(canAcceptAdvance(500, [], 11_500, 23)).toBe(true);
      expect(canAcceptAdvance(500, [], 11_501, 23)).toBe(false);
    });
  });

  describe("isSettlementReady", () => {
    it("returns false before the cycle end_date", () => {
      expect(isSettlementReady(new Date("2026-04-15T12:00:00Z"), "2026-04-30")).toBe(false);
    });

    it("returns true on the cycle end_date", () => {
      expect(isSettlementReady(new Date("2026-04-30T12:00:00Z"), "2026-04-30")).toBe(true);
    });

    it("returns true after the cycle end_date", () => {
      expect(isSettlementReady(new Date("2026-05-15T12:00:00Z"), "2026-04-30")).toBe(true);
    });
  });

  describe("isCycleClosedForTransactions", () => {
    it("returns false for an active cycle", () => {
      expect(isCycleClosedForTransactions({ status: "active" })).toBe(false);
    });

    it("returns false for a with_advance cycle (still open for writes)", () => {
      expect(isCycleClosedForTransactions({ status: "with_advance" })).toBe(false);
    });

    it("returns true for a completed cycle", () => {
      expect(isCycleClosedForTransactions({ status: "completed" })).toBe(true);
    });

    it("returns true for a settled cycle", () => {
      expect(isCycleClosedForTransactions({ status: "settled" })).toBe(true);
    });

    it("returns false for a null cycle (no cycle = nothing to gate)", () => {
      expect(isCycleClosedForTransactions(null)).toBe(false);
    });
  });

  describe("constants", () => {
    it("DEFAULT_CYCLE_ENDING_WINDOW_DAYS is 7 (frozen contract)", () => {
      expect(DEFAULT_CYCLE_ENDING_WINDOW_DAYS).toBe(7);
    });

    it("RATTRAPAGE_DAY_OPTIONS is exactly [2, 3, 4] (frozen contract per BDD line 857)", () => {
      expect(RATTRAPAGE_DAY_OPTIONS).toEqual([2, 3, 4]);
    });

    it("MIN_CYCLE_LENGTH_DAYS is 3 (ADR-004 Amendment A1.5 default)", () => {
      expect(MIN_CYCLE_LENGTH_DAYS).toBe(3);
    });
  });

  describe("daysUntilCycleEnd", () => {
    it("day 1 of a 30-day cycle → 29 days remaining", () => {
      expect(daysUntilCycleEnd(1, 30)).toBe(29);
    });

    it("day 15 of a 30-day cycle → 15 days remaining", () => {
      expect(daysUntilCycleEnd(15, 30)).toBe(15);
    });

    it("last day → 0 days remaining (boundary)", () => {
      expect(daysUntilCycleEnd(30, 30)).toBe(0);
    });

    it("clamps out-of-band day > cycleLength to 0 (defensive)", () => {
      expect(daysUntilCycleEnd(31, 30)).toBe(0);
    });

    it("a 24-day partial cycle on day 1 → 23 remaining", () => {
      expect(daysUntilCycleEnd(1, 24)).toBe(23);
    });
  });

  describe("isCycleInUpcomingEndWindow", () => {
    it("day 23 of a 30-day cycle, window 7 → true (7 remaining, inclusive)", () => {
      expect(isCycleInUpcomingEndWindow(23, 7, 30)).toBe(true);
    });

    it("day 24 of a 30-day cycle, window 7 → true (6 remaining)", () => {
      expect(isCycleInUpcomingEndWindow(24, 7, 30)).toBe(true);
    });

    it("day 22 of a 30-day cycle, window 7 → false (8 remaining, outside)", () => {
      expect(isCycleInUpcomingEndWindow(22, 7, 30)).toBe(false);
    });

    it("last day, window 7 → true (0 remaining, inclusive boundary)", () => {
      expect(isCycleInUpcomingEndWindow(30, 7, 30)).toBe(true);
    });

    it("INV: isCycleInUpcomingEndWindow(day, w, len) ≡ (len − day ≤ w) — day constrained to [1, cycleLength] so the clamp does not vacuously satisfy the property", () => {
      fc.assert(
        fc.property(
          // Chain so `day` cannot exceed `cycleLength` — out-of-range days
          // would clamp daysUntilCycleEnd to 0 and make the property
          // vacuously true regardless of implementation correctness.
          fc
            .integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 })
            .chain((cycleLength) =>
              fc.tuple(
                fc.constant(cycleLength),
                fc.integer({ min: 1, max: cycleLength }),
                fc.integer({ min: 0, max: 31 }),
              ),
            ),
          ([cycleLength, day, windowDays]) => {
            const expected = cycleLength - day <= windowDays;
            return isCycleInUpcomingEndWindow(day, windowDays, cycleLength) === expected;
          },
        ),
      );
    });
  });

  describe("computeMemberStats", () => {
    const NOW = new Date("2026-04-15T12:00:00Z");
    const CYCLE = { startDate: "2026-04-01", endDate: "2026-04-30" };

    it("returns zeros for cycle fields when currentCycle is null", () => {
      const stats = computeMemberStats([], { dailyAmount: 500 }, null, NOW);
      expect(stats).toEqual({
        cycleDay: 0,
        cycleLength: 0,
        daysRemaining: 0,
        contributedTotal: 0,
        outstandingAdvances: 0,
        projectedFinalBalance: 0,
      });
    });

    it("exposes cycleLength (Story 11.4) — 30-day cycle", () => {
      const stats = computeMemberStats([], { dailyAmount: 500 }, CYCLE, NOW);
      expect(stats.cycleLength).toBe(30);
    });

    it("exposes cycleLength (Story 11.4) — 24-day partial cycle", () => {
      const partial = { startDate: "2026-04-07", endDate: "2026-04-30" };
      const stats = computeMemberStats([], { dailyAmount: 500 }, partial, NOW);
      expect(stats.cycleLength).toBe(24);
    });

    it("still aggregates transaction totals even when currentCycle is null", () => {
      const stats = computeMemberStats(
        [
          { kind: "contribution", amount: 500 },
          { kind: "advance", amount: 3000 },
        ],
        { dailyAmount: 500 },
        null,
        NOW,
      );
      expect(stats.contributedTotal).toBe(500);
      expect(stats.outstandingAdvances).toBe(3000);
    });

    it("aggregates contribution + rattrapage into contributedTotal; advance into outstandingAdvances", () => {
      const stats = computeMemberStats(
        [
          { kind: "contribution", amount: 500 },
          { kind: "rattrapage", amount: 1000 },
          { kind: "advance", amount: 3000 },
        ],
        { dailyAmount: 500 },
        CYCLE,
        NOW,
      );
      expect(stats.contributedTotal).toBe(1500);
      expect(stats.outstandingAdvances).toBe(3000);
      expect(stats.cycleDay).toBe(15);
      expect(stats.daysRemaining).toBe(15); // 30-day cycle, day 15
      expect(stats.projectedFinalBalance).toBe(14_500 - 3000); // 500 × 29 − 3000
    });

    it("a 24-day partial cycle yields the partial-cycle projection", () => {
      const partial = { startDate: "2026-04-07", endDate: "2026-04-30" };
      const stats = computeMemberStats([], { dailyAmount: 500 }, partial, NOW);
      // cycleLength 24 → contributionDays 23 → 500 × 23 = 11_500.
      expect(stats.projectedFinalBalance).toBe(11_500);
    });

    it("uses the parameter default for `now` when omitted (boundary safety)", () => {
      const stats = computeMemberStats([], { dailyAmount: 500 }, CYCLE);
      expect(Number.isFinite(stats.cycleDay)).toBe(true);
      expect(stats.cycleDay).toBeGreaterThanOrEqual(1);
      expect(stats.cycleDay).toBeLessThanOrEqual(30);
    });
  });
});
