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
  MAX_CYCLE_END_DAY,
  MIN_CYCLE_LENGTH_DAYS,
  RATTRAPAGE_DAY_OPTIONS,
  canAcceptAdvance,
  commission,
  computeMemberStats,
  computeOpeningBalance,
  computeCurrentBalance,
  cycleDay,
  cycleLengthDays,
  daysUntilCycleEnd,
  deriveCycleBounds,
  isCycleClosedForTransactions,
  isCycleInUpcomingEndWindow,
  isSettlementReady,
  settle,
  type OpeningBalanceCycle,
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

/** Test-only oracle: an endDate is a VALID cap-aware month boundary iff it
 *  is either day MAX_CYCLE_END_DAY (cap clamp hit) OR the actual last day
 *  of its month (cap was inert because the month was already ≤ 30 days).
 *  Story 11.5 § A1.8. */
function isCappedMonthBoundary(isoDate: string): boolean {
  return (
    isoDate.endsWith(`-${String(MAX_CYCLE_END_DAY).padStart(2, "0")}`) || isLastDayOfMonth(isoDate)
  );
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
  it("INV-1 (12.5 PR C rewrite): currentBalance depends only on its 4 inputs — not on cycleDay/now", () => {
    // The pre-12.5 invariant was structural to the engine API: the
    // projection had no time input. Story 12.5 PR C keeps that property
    // (computeCurrentBalance still has no `now` argument) but the
    // formula itself moves from daily×contribDays to contributedTotal −
    // daily − Σ(advances) − openingBalance.
    fc.assert(
      fc.property(
        fc.record({
          contributedTotal: fc.integer({ min: 0, max: 10_000_000 }),
          dailyAmount: fc.integer({ min: 100, max: 100_000 }),
          advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 31 }),
          openingBalance: fc.integer({ min: 0, max: 1_000_000 }),
        }),
        ({ contributedTotal, dailyAmount, advances, openingBalance }) => {
          const a = computeCurrentBalance(
            contributedTotal,
            dailyAmount,
            sum(advances),
            openingBalance,
          );
          const b = computeCurrentBalance(
            contributedTotal,
            dailyAmount,
            sum(advances),
            openingBalance,
          );
          return a === b && a === contributedTotal - dailyAmount - sum(advances) - openingBalance;
        },
      ),
    );
  });

  it("INV-2 (12.5 rewrite): settle returns contributedTotal − daily − Σadvances − openingBalance (cotisation libre)", () => {
    // Pre-12.5 INV-2 claimed settle === projected at cycle end for
    // fully-paid cycles. That invariant assumed the saver versed
    // daily × contributionDays exactly, which doesn't match the real
    // model (cotisation libre). The new property: settle is the pure
    // arithmetic of what the collector physically owes the saver.
    fc.assert(
      fc.property(
        fc.record({
          contributedTotal: fc.integer({ min: 0, max: 10_000_000 }),
          dailyAmount: fc.integer({ min: 100, max: 100_000 }),
          advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
          openingBalance: fc.integer({ min: 0, max: 1_000_000 }),
        }),
        ({ contributedTotal, dailyAmount, advances, openingBalance }) => {
          const settled = settle(contributedTotal, dailyAmount, advances, openingBalance);
          return settled === contributedTotal - dailyAmount - sum(advances) - openingBalance;
        },
      ),
    );
  });

  it("INV-3 (12.5 PR B rewrite): advance accepted iff Σ(existing) + new ≤ contributedTotal", () => {
    // Pre-12.5 INV-3 capped by dailyAmount × contributionDays (the
    // contract projection). The new model caps by ACTUAL contributedTotal:
    // the collector never advances more than what's been versed so far.
    fc.assert(
      fc.property(
        fc.record({
          contributedTotal: fc.integer({ min: 0, max: 10_000_000 }),
          existing: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 20 }),
          newAdvance: fc.integer({ min: 1, max: 100_000 }),
        }),
        ({ contributedTotal, existing, newAdvance }) => {
          const expected = sum(existing) + newAdvance <= contributedTotal;
          return canAcceptAdvance(contributedTotal, existing, newAdvance) === expected;
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
          contributedTotal: fc.integer({ min: 0, max: 10_000_000 }),
          dailyAmount: fc.integer({ min: 100, max: 100_000 }),
          advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
        }),
        (s) => {
          const a = settle(s.contributedTotal, s.dailyAmount, s.advances);
          const b = settle(s.contributedTotal, s.dailyAmount, s.advances);
          return a === b;
        },
      ),
    );
  });

  it("INV-8: every monetary output is an integer FCFA (propIntegerFcfaOutputs)", () => {
    fc.assert(
      fc.property(
        fc.record({
          contributedTotal: fc.integer({ min: 0, max: 10_000_000 }),
          dailyAmount: fc.integer({ min: 100, max: 100_000 }),
          advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
          contributionDays: fc.integer({ min: MIN_CYCLE_LENGTH_DAYS - 1, max: 30 }),
        }),
        (s) => {
          const current = computeCurrentBalance(s.contributedTotal, s.dailyAmount, sum(s.advances));
          const settled = settle(s.contributedTotal, s.dailyAmount, s.advances);
          const comm = commission(s.dailyAmount);
          return [current, settled, comm].every(Number.isInteger);
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

          // (a) endDate is a cap-aware month boundary: either the cap day
          //     (30) or the actual month-end for ≤30-day months. Story 11.5
          //     § A1.8.
          if (!isCappedMonthBoundary(endDate)) return false;
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

  // -------------------------------------------------------------------------
  // Story 12.3 — opening_balance carry-over property tests.
  // -------------------------------------------------------------------------

  it("INV-1 (extended, 12.5 PR C): currentBalance = contributedTotal − daily − Σ(advances) − openingBalance", () => {
    fc.assert(
      fc.property(
        fc.record({
          contributedTotal: fc.integer({ min: 0, max: 10_000_000 }),
          dailyAmount: fc.integer({ min: 100, max: 100_000 }),
          advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 31 }),
          openingBalance: fc.integer({ min: 0, max: 1_000_000 }),
        }),
        ({ contributedTotal, dailyAmount, advances, openingBalance }) => {
          const current = computeCurrentBalance(
            contributedTotal,
            dailyAmount,
            sum(advances),
            openingBalance,
          );
          return current === contributedTotal - dailyAmount - sum(advances) - openingBalance;
        },
      ),
    );
  });

  it("Story 12.5 PR B — when contributedTotal = 0, every positive advance is rejected", () => {
    // Symmetric to the pre-12.5 Q2bis property (which gated on
    // openingBalance ≥ daily × contribDays). The new model: nothing
    // versed yet → nothing to lend against.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 20 }),
        (newAdvance, existing) => {
          return canAcceptAdvance(0, existing, newAdvance) === false;
        },
      ),
    );
  });

  it("propOpeningBalanceMonotonic: ∀ ob₁ ≤ ob₂ ⇒ currentBalance(ob₂) ≤ currentBalance(ob₁)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 100, max: 100_000 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 31 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        (contributedTotal, dailyAmount, advances, ob1, ob2) => {
          const [low, high] = ob1 <= ob2 ? [ob1, ob2] : [ob2, ob1];
          const currentLow = computeCurrentBalance(
            contributedTotal,
            dailyAmount,
            sum(advances),
            low,
          );
          const currentHigh = computeCurrentBalance(
            contributedTotal,
            dailyAmount,
            sum(advances),
            high,
          );
          return currentHigh <= currentLow;
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Story 12.3 — computeOpeningBalance example tests (recursion behaviour).
// ---------------------------------------------------------------------------

describe("computeOpeningBalance (Story 12.3, rewritten for Story 12.5 PR D)", () => {
  // Story 12.5 PR D — prev_balance now uses contributedTotal, not daily ×
  // contribDays. To preserve the legacy "14 500 / advances" arithmetic the
  // older tests asserted on, each fixture below seeds contributedTotal =
  // 15 000 (= daily + 14 500) so `contrib − daily = 14 500` is the same
  // residual the OLD formula computed via `daily × contribDays`.
  const DAILY = 500;
  const LEGACY_CONTRIB = 15_000; // (= daily × cycleLength = 500 × 30)
  const makeCycle = (
    id: string,
    cycleNumber: number,
    startDate: string,
    endDate: string,
    status: OpeningBalanceCycle["status"],
  ): OpeningBalanceCycle => ({ id, cycleNumber, startDate, endDate, status });

  it("first cycle (cycle_number = 1) → 0", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-05-01", "2026-05-30", "active"),
    ];
    expect(computeOpeningBalance(cycles, new Map(), new Map(), DAILY, "c1")).toBe(0);
  });

  it("previous cycle is 'settled' → 0 (chain restarts)", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-04-01", "2026-04-30", "settled"),
      makeCycle("c2", 2, "2026-05-01", "2026-05-30", "active"),
    ];
    const advances = new Map<string, number>([["c1", 50_000]]); // huge unpaid but settled
    const contributed = new Map<string, number>([["c1", LEGACY_CONTRIB]]);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c2")).toBe(0);
  });

  it("previous cycle had no debt (positive final balance) → 0", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-04-01", "2026-04-30", "completed"),
      makeCycle("c2", 2, "2026-05-01", "2026-05-30", "active"),
    ];
    // contrib(15_000) − daily(500) − advances(1_000) = 13_500 > 0 → no debt.
    const advances = new Map<string, number>([["c1", 1_000]]);
    const contributed = new Map<string, number>([["c1", LEGACY_CONTRIB]]);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c2")).toBe(0);
  });

  it("previous cycle ended with debt → positive carry-over", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-04-01", "2026-04-30", "completed"),
      makeCycle("c2", 2, "2026-05-01", "2026-05-30", "active"),
    ];
    // contrib(15_000) − daily(500) − advances(20_000) = −5_500 → carry-over 5_500.
    const advances = new Map<string, number>([["c1", 20_000]]);
    const contributed = new Map<string, number>([["c1", LEGACY_CONTRIB]]);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c2")).toBe(5_500);
  });

  it("3-cycle chain, c1 settled → c3 sees only c2's debt", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-03-01", "2026-03-30", "settled"),
      makeCycle("c2", 2, "2026-04-01", "2026-04-30", "completed"),
      makeCycle("c3", 3, "2026-05-01", "2026-05-30", "active"),
    ];
    // c2: opening = 0 (c1 settled). contrib(15_000) − daily(500) − advances(17_000) = −2_500.
    // c3 carries 2_500 (c2's debt).
    const advances = new Map<string, number>([["c2", 17_000]]);
    const contributed = new Map<string, number>([["c2", LEGACY_CONTRIB]]);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c3")).toBe(2_500);
  });

  it("3-cycle chain, none settled → debt accumulates", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-03-01", "2026-03-30", "completed"),
      makeCycle("c2", 2, "2026-04-01", "2026-04-30", "completed"),
      makeCycle("c3", 3, "2026-05-01", "2026-05-30", "active"),
    ];
    // c1: opening=0. contrib(15_000) − 500 − adv(16_000) = −1_500 → c2 opening = 1_500.
    // c2: opening=1_500. contrib(15_000) − 500 − adv(14_500) − 1_500 = −1_500 → c3 opening = 1_500.
    const advances = new Map<string, number>([
      ["c1", 16_000],
      ["c2", 14_500],
    ]);
    const contributed = new Map<string, number>([
      ["c1", LEGACY_CONTRIB],
      ["c2", LEGACY_CONTRIB],
    ]);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c2")).toBe(1_500);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c3")).toBe(1_500);
  });

  it("3-cycle chain, c2 repays past debt and contributes more → c3 opening = 0", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-03-01", "2026-03-30", "completed"),
      makeCycle("c2", 2, "2026-04-01", "2026-04-30", "completed"),
      makeCycle("c3", 3, "2026-05-01", "2026-05-30", "active"),
    ];
    // c1 debt = 5_000 → c2 opening = 5_000.
    // c2: contrib(15_000) − 500 − advances(0) − 5_000 = 9_500 → no debt to carry → c3 opening = 0.
    const advances = new Map<string, number>([["c1", 19_500]]);
    const contributed = new Map<string, number>([
      ["c1", LEGACY_CONTRIB],
      ["c2", LEGACY_CONTRIB],
    ]);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c2")).toBe(5_000);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c3")).toBe(0);
  });

  it("unknown cycle id → 0 (defensive)", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-05-01", "2026-05-30", "active"),
    ];
    expect(computeOpeningBalance(cycles, new Map(), new Map(), DAILY, "does-not-exist")).toBe(0);
  });

  it("missing previous cycle in array → 0 (gap in chain)", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c2", 2, "2026-05-01", "2026-05-30", "active"),
      // c1 missing (cycle_number = 1 absent from the array)
    ];
    expect(computeOpeningBalance(cycles, new Map(), new Map(), DAILY, "c2")).toBe(0);
  });

  it("equality boundary: prev balance exactly 0 → no carry-over", () => {
    const cycles: OpeningBalanceCycle[] = [
      makeCycle("c1", 1, "2026-04-01", "2026-04-30", "completed"),
      makeCycle("c2", 2, "2026-05-01", "2026-05-30", "active"),
    ];
    // contrib(15_000) − daily(500) − advances(14_500) = 0 → 0 carry-over.
    const advances = new Map<string, number>([["c1", 14_500]]);
    const contributed = new Map<string, number>([["c1", LEGACY_CONTRIB]]);
    expect(computeOpeningBalance(cycles, advances, contributed, DAILY, "c2")).toBe(0);
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

    it("residual below MIN → roll-forward to the next month (capped at day 30)", () => {
      // 2026-04-29 → rawLen = 2 < 3 → roll to May. May has 31 days but the
      // cap (§ A1.8) clamps end to the 30th, length 30.
      expect(deriveCycleBounds("2026-04-29")).toEqual({
        startDate: "2026-05-01",
        endDate: "2026-05-30",
      });
    });

    it("roll-forward across the year boundary — December → January next year (capped)", () => {
      // 2026-12-30 → rawLen = 1 < 3 (cap clamps Dec end to the 30th too) →
      // roll to January 2027, capped end on the 30th.
      expect(deriveCycleBounds("2026-12-30")).toEqual({
        startDate: "2027-01-01",
        endDate: "2027-01-30",
      });
    });

    it("registration on the last day of a 30-day month rolls forward (rawLen = 1)", () => {
      // June has 30 days; cap is inert there. Roll to July, capped on the 30th.
      expect(deriveCycleBounds("2026-06-30")).toEqual({
        startDate: "2026-07-01",
        endDate: "2026-07-30",
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
      // 2028-02-28 → rawLen = 29 − 28 + 1 = 2 < 3 → roll to March 2028
      // (31-day month, cap clamps end to the 30th).
      expect(deriveCycleBounds("2028-02-28")).toEqual({
        startDate: "2028-03-01",
        endDate: "2028-03-30",
      });
    });

    // Story 11.5 § A1.8 — cap-rule example tests (31-day months only;
    // 28/29/30-day months are unaffected by the cap and covered above).
    it("31-day month, registration on the 1st → cycle ends day 30, length 30 (cap clamps)", () => {
      expect(deriveCycleBounds("2026-05-01")).toEqual({
        startDate: "2026-05-01",
        endDate: "2026-05-30",
      });
      expect(cycleLengthDays("2026-05-01", "2026-05-30")).toBe(30);
    });

    it("31-day month, registration on the 25th (operator threshold) → length 6", () => {
      // The pilot collector reports members are always added before the
      // 25th. Worked example confirming the cap shortens by exactly 1 day
      // vs. the pre-11.5 behaviour (was: May 31, length 7).
      expect(deriveCycleBounds("2026-05-25")).toEqual({
        startDate: "2026-05-25",
        endDate: "2026-05-30",
      });
      expect(cycleLengthDays("2026-05-25", "2026-05-30")).toBe(6);
    });

    it("31-day month, registration on (lastDay − 2) → exactly MIN_CYCLE_LENGTH_DAYS, no roll", () => {
      // 2026-05-28 → cap-end = May 30 → rawLen = 30 − 28 + 1 = 3 = MIN
      // → stays in May. Boundary of the inclusive ≥ comparison after the
      // cap shifts the threshold by 1 vs. pre-11.5.
      expect(deriveCycleBounds("2026-05-28")).toEqual({
        startDate: "2026-05-28",
        endDate: "2026-05-30",
      });
    });

    it("31-day month, registration on (lastDay − 1) rolls (cap-shifted boundary)", () => {
      // 2026-05-29 → cap-end = May 30 → rawLen = 30 − 29 + 1 = 2 < MIN
      // → roll to June (30-day month, cap inert, length 30).
      // Pre-11.5 this case would have stayed in May (length 3); the cap
      // shifts the rollover boundary by exactly 1 day for 31-day months.
      expect(deriveCycleBounds("2026-05-29")).toEqual({
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      });
    });

    it("31-day December, registration on (lastDay − 2) rolls to next-year January (cap-shifted)", () => {
      // 2026-12-29 → cap-end = Dec 30 → rawLen = 2 < MIN → roll to Jan 2027
      // (also 31-day, capped). Pre-11.5 this would have stayed in Dec.
      expect(deriveCycleBounds("2026-12-29")).toEqual({
        startDate: "2027-01-01",
        endDate: "2027-01-30",
      });
    });
  });

  describe("computeCurrentBalance (Story 12.5 PR C — replaces computeProjectedFinalBalance)", () => {
    it("contributedTotal=15_000, daily=500, no advances → 14_500 (collector owes the saver this much)", () => {
      expect(computeCurrentBalance(15_000, 500, 0)).toBe(14_500);
    });

    it("contributedTotal=14_500, daily=500, advances=3000 → 11_000", () => {
      expect(computeCurrentBalance(14_500, 500, 3000)).toBe(11_000);
    });

    it("openingBalance argument is subtracted (carry-over from previous cycle)", () => {
      expect(computeCurrentBalance(15_000, 500, 0, 5_000)).toBe(9_500);
    });

    it("returns a negative value when advances + commission > contributedTotal (saver owes — carry-over candidate)", () => {
      expect(computeCurrentBalance(5_000, 1_000, 5_000)).toBe(-1_000);
    });
  });

  describe("settle (Story 12.5 — cotisation libre)", () => {
    it("contributedTotal=29_000, daily=1000, no advances → 28_000 payout", () => {
      // Saver versed 29 000, collector keeps 1 000 commission → saver
      // receives 28 000. Same numeric output the legacy formula gave
      // (1000 × 29 = 29 000 - 1 000 = 28 000 ≡ contributedTotal − daily).
      expect(settle(29_000, 1000, [])).toBe(28_000);
    });

    it("contributedTotal=14_500, daily=500, advances [3000, 2000] → 9_000", () => {
      // 14 500 - 500(commission) - 5 000(advances) = 9 000.
      expect(settle(14_500, 500, [3000, 2000])).toBe(9_000);
    });

    it("Khadim repro — contributedTotal=66_000, daily=7000, no advances → 59_000", () => {
      // The pilot-flagged case from the UX feedback session 2026-05-21:
      // saver versed only 66 000 (not the full 210 000 the contract
      // projected). Old formula returned 203 000 — completely wrong.
      // New formula: 66 000 − 7 000 − 0 = 59 000.
      expect(settle(66_000, 7000, [])).toBe(59_000);
    });

    it("openingBalance argument is subtracted from the payout", () => {
      expect(settle(50_000, 1000, [], 5_000)).toBe(44_000);
    });

    it("negative payout when advances + commission exceed contributedTotal (saver owes)", () => {
      // contributedTotal 5_000, daily 1_000, advances 5_000 → −1_000.
      // The UI / commit_cycle_settlement decide what to do with debts
      // (carry to next cycle via opening_balance, or reject).
      expect(settle(5_000, 1_000, [5_000])).toBe(-1_000);
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

  describe("canAcceptAdvance (Story 12.5 PR B — contributedTotal cap)", () => {
    it("accepts an advance that exactly hits contributedTotal", () => {
      expect(canAcceptAdvance(14_500, [], 14_500)).toBe(true);
    });

    it("rejects an advance over by 1 FCFA", () => {
      expect(canAcceptAdvance(14_500, [], 14_501)).toBe(false);
    });

    it("respects existing advances", () => {
      expect(canAcceptAdvance(14_500, [10_000], 4_500)).toBe(true); // total 14_500 = cap
      expect(canAcceptAdvance(14_500, [10_000], 4_501)).toBe(false); // over by 1
    });

    it("capacity = contributedTotal regardless of cycle length", () => {
      // 11 500 versé so far → max advance 11 500 minus existing.
      expect(canAcceptAdvance(11_500, [], 11_500)).toBe(true);
      expect(canAcceptAdvance(11_500, [], 11_501)).toBe(false);
    });

    it("0 versé so far → no advance possible", () => {
      expect(canAcceptAdvance(0, [], 1)).toBe(false);
      expect(canAcceptAdvance(0, [], 0)).toBe(true);
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

    it("MAX_CYCLE_END_DAY is 30 (ADR-004 Amendment A1.8 cap rule)", () => {
      expect(MAX_CYCLE_END_DAY).toBe(30);
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
        openingBalance: 0,
        currentBalance: 0,
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
      // Story 12.5 PR C — currentBalance = contributedTotal − daily − advances − opening.
      //                                  = 1500 − 500 − 3000 − 0 = −2000 (saver owes).
      expect(stats.currentBalance).toBe(1500 - 500 - 3000);
    });

    it("a 24-day partial cycle with 0 contribs gives negative currentBalance (saver owes daily commission)", () => {
      const partial = { startDate: "2026-04-07", endDate: "2026-04-30" };
      const stats = computeMemberStats([], { dailyAmount: 500 }, partial, NOW);
      // Story 12.5 PR C — no contribs yet → currentBalance = 0 − 500 − 0 − 0 = −500.
      expect(stats.currentBalance).toBe(-500);
    });

    it("uses the parameter default for `now` when omitted (boundary safety)", () => {
      const stats = computeMemberStats([], { dailyAmount: 500 }, CYCLE);
      expect(Number.isFinite(stats.cycleDay)).toBe(true);
      expect(stats.cycleDay).toBeGreaterThanOrEqual(1);
      expect(stats.cycleDay).toBeLessThanOrEqual(30);
    });
  });
});
