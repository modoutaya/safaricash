// Story 3.2 — cycle engine tests.
//
// 8 property tests via fast-check (one per ADR-004 invariant) + example
// tests for documentation + boundary coverage. Test names quote ADR-004's
// plain-English statement verbatim so failures surface invariant intent
// at the runner's first line.
//
// See: docs/ADR/004-cycle-invariants.md

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CONTRIBUTION_DAYS,
  CYCLE_TOTAL_DAYS,
  canAcceptAdvance,
  commission,
  computeMemberStats,
  computeProjectedFinalBalance,
  cycleDay,
  isSettlementReady,
  settle,
} from "./cycleEngine";

const sum = (xs: ReadonlyArray<number>): number => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Property tests — one per ADR-004 invariant.
// ---------------------------------------------------------------------------

describe("cycleEngine — property tests (ADR-004 invariants)", () => {
  it("INV-1: projected balance depends only on dailyAmount and Σ(advances) (propProjectedBalanceTimeInvariance)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 0, maxLength: 30 }),
        (dailyAmount, advances) => {
          const a = computeProjectedFinalBalance(dailyAmount, sum(advances));
          const b = computeProjectedFinalBalance(dailyAmount, sum(advances));
          return a === b && a === dailyAmount * CONTRIBUTION_DAYS - sum(advances);
        },
      ),
    );
  });

  it("INV-2: settled balance ≡ projected balance at day 30 for fully-paid cycles (propSettledEqualsProjectedAtDay30)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 100_000 }), (dailyAmount) => {
        const settled = settle(dailyAmount, []);
        const projected = computeProjectedFinalBalance(dailyAmount, 0);
        return settled === projected && settled === dailyAmount * CONTRIBUTION_DAYS;
      }),
    );
  });

  it("INV-3: advance request is accepted iff total advances stay within capacity (propAdvanceCapacityBound)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 100_000 }),
        (dailyAmount, existing, newAdvance) => {
          const totalIfAccepted = sum(existing) + newAdvance;
          const capacity = dailyAmount * CONTRIBUTION_DAYS;
          const expected = totalIfAccepted <= capacity;
          return canAcceptAdvance(dailyAmount, existing, newAdvance) === expected;
        },
      ),
    );
  });

  it("INV-4: commission is exactly 1 × dailyAmount, regardless of any other input (propCommissionInvariance)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 100_000 }), (dailyAmount) => {
        return commission(dailyAmount) === dailyAmount;
      }),
    );
  });

  it("INV-5: cycleDay is clamped to [1, 30] (propCycleDayClamped)", () => {
    // noInvalidDate filters out the NaN-Date sentinels fast-check would
    // otherwise generate (toISOString throws on those, masking the real
    // property check).
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2026-01-01"),
          max: new Date("2026-12-31"),
          noInvalidDate: true,
        }),
        fc.integer({ min: -100, max: 100 }),
        (start, dayOffset) => {
          const startDate = start.toISOString().slice(0, 10);
          const now = new Date(start.getTime() + dayOffset * 86_400_000);
          const day = cycleDay(startDate, now);
          return day >= 1 && day <= 30;
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
      fc.property(validDate, validDate, validDate, (start, t1, t2) => {
        const startDate = start.toISOString().slice(0, 10);
        const [early, late] = t1 < t2 ? [t1, t2] : [t2, t1];
        return cycleDay(startDate, early) <= cycleDay(startDate, late);
      }),
    );
  });

  it("INV-7: settle() is referentially transparent (propSettlementDeterministic)", () => {
    fc.assert(
      fc.property(
        fc.record({
          dailyAmount: fc.integer({ min: 100, max: 100_000 }),
          advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
        }),
        (s) => {
          const a = settle(s.dailyAmount, s.advances);
          const b = settle(s.dailyAmount, s.advances);
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
        }),
        (s) => {
          const projected = computeProjectedFinalBalance(s.dailyAmount, sum(s.advances));
          const settled = settle(s.dailyAmount, s.advances);
          const comm = commission(s.dailyAmount);
          return [projected, settled, comm].every(Number.isInteger);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Example-based tests — concrete values + boundary coverage.
// ---------------------------------------------------------------------------

describe("cycleEngine — example tests", () => {
  describe("computeProjectedFinalBalance", () => {
    it("dailyAmount=500, no advances → 14_500", () => {
      expect(computeProjectedFinalBalance(500, 0)).toBe(14_500);
    });

    it("dailyAmount=500, advances=3000 → 11_500", () => {
      expect(computeProjectedFinalBalance(500, 3000)).toBe(11_500);
    });

    it("returns a negative value when advances exceed capacity (Q1 — raw value)", () => {
      // dailyAmount × 29 = 14_500; advances = 20_000 → projected = −5_500
      expect(computeProjectedFinalBalance(500, 20_000)).toBe(-5_500);
    });
  });

  describe("settle", () => {
    it("dailyAmount=1000 + no advances → 29_000", () => {
      expect(settle(1000, [])).toBe(29_000);
    });

    it("dailyAmount=500 + advances [3000, 2000] → 9_500", () => {
      expect(settle(500, [3000, 2000])).toBe(9_500);
    });
  });

  describe("commission", () => {
    it("is exactly 1 × dailyAmount", () => {
      expect(commission(500)).toBe(500);
      expect(commission(100_000)).toBe(100_000);
    });
  });

  describe("cycleDay", () => {
    it("returns 15 on day 15 of a cycle starting 2026-04-01", () => {
      expect(cycleDay("2026-04-01", new Date("2026-04-15T12:00:00Z"))).toBe(15);
    });

    it("returns 1 when now is BEFORE startDate (clamped)", () => {
      expect(cycleDay("2026-04-15", new Date("2026-04-01T00:00:00Z"))).toBe(1);
    });

    it("returns 30 when now is 35 days after startDate (clamped)", () => {
      expect(cycleDay("2026-04-01", new Date("2026-05-06T12:00:00Z"))).toBe(30);
    });

    it("returns 1 on day 1 (boundary)", () => {
      expect(cycleDay("2026-04-01", new Date("2026-04-01T00:00:00Z"))).toBe(1);
    });

    it("returns 30 on day 30 (boundary)", () => {
      expect(cycleDay("2026-04-01", new Date("2026-04-30T23:59:59Z"))).toBe(30);
    });
  });

  describe("canAcceptAdvance", () => {
    it("accepts an advance that exactly hits capacity", () => {
      expect(canAcceptAdvance(500, [], 14_500)).toBe(true);
    });

    it("rejects an advance over by 1 FCFA", () => {
      expect(canAcceptAdvance(500, [], 14_501)).toBe(false);
    });

    it("respects existing advances", () => {
      expect(canAcceptAdvance(500, [10_000], 4_500)).toBe(true); // total 14_500 = capacity
      expect(canAcceptAdvance(500, [10_000], 4_501)).toBe(false); // over by 1
    });
  });

  describe("isSettlementReady", () => {
    it("returns false before day 30", () => {
      expect(isSettlementReady(new Date("2026-04-15T12:00:00Z"), "2026-04-01")).toBe(false);
    });

    it("returns true at day 30", () => {
      expect(isSettlementReady(new Date("2026-04-30T12:00:00Z"), "2026-04-01")).toBe(true);
    });

    it("returns true after day 30", () => {
      expect(isSettlementReady(new Date("2026-05-15T12:00:00Z"), "2026-04-01")).toBe(true);
    });
  });

  describe("computeMemberStats", () => {
    const NOW = new Date("2026-04-15T12:00:00Z");
    const CYCLE = { startDate: "2026-04-01" };

    it("returns zeros when currentCycle is null", () => {
      const stats = computeMemberStats([], { dailyAmount: 500 }, null, NOW);
      expect(stats).toEqual({
        cycleDay: 0,
        daysRemaining: 0,
        contributedTotal: 0,
        outstandingAdvances: 0,
        projectedFinalBalance: 0,
      });
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
      expect(stats.daysRemaining).toBe(CYCLE_TOTAL_DAYS - 15);
      expect(stats.projectedFinalBalance).toBe(14_500 - 3000);
    });

    it("uses the parameter default for `now` when omitted (boundary safety)", () => {
      // Just exercise the default-arg branch; assert the call doesn't throw
      // and returns a finite cycleDay.
      const stats = computeMemberStats([], { dailyAmount: 500 }, CYCLE);
      expect(Number.isFinite(stats.cycleDay)).toBe(true);
      expect(stats.cycleDay).toBeGreaterThanOrEqual(1);
      expect(stats.cycleDay).toBeLessThanOrEqual(30);
    });
  });
});
