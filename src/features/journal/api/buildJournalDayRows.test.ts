// Story 12.2 — pure tests for the calendar-day view builder.

import { describe, expect, it } from "vitest";

import { buildJournalDayRows, type DayRow } from "./buildJournalDayRows";
import type { JournalCycleBounds } from "./useJournalMembers";
import type { JournalTransaction } from "./useJournalTransactions";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CYCLE_PREV: JournalCycleBounds = {
  id: "cyc-prev",
  cycleNumber: 1,
  startDate: "2026-04-01",
  endDate: "2026-04-30", // 30-day cycle, commission day = day 30 = 2026-04-30
};

const CYCLE_CURR: JournalCycleBounds = {
  id: "cyc-curr",
  cycleNumber: 2,
  startDate: "2026-05-01",
  endDate: "2026-05-30", // 30-day cycle (cap-30 at May 31-day month)
};

const member = { currentCycle: CYCLE_CURR, previousCycle: CYCLE_PREV };

let txIdCounter = 0;
function makeTx(input: {
  kind: "contribution" | "rattrapage" | "advance";
  cycleId: string;
  cycleDay: number;
  daysCovered?: number;
  amount?: number;
}): JournalTransaction {
  return {
    id: `tx-${++txIdCounter}`,
    kind: input.kind,
    amount: input.amount ?? 500,
    createdAt: `2026-05-01T10:00:00Z`,
    cycleDay: input.cycleDay,
    cycleId: input.cycleId,
    daysCovered: input.daysCovered ?? null,
  };
}

function kindsByDate(rows: ReadonlyArray<DayRow>): Array<{ date: string; kind: string }> {
  return rows.map((r) => ({ date: r.date, kind: r.kind }));
}

// ---------------------------------------------------------------------------
// Pilot example — the user's canonical case.
// ---------------------------------------------------------------------------

describe("buildJournalDayRows — pilot example (cycle previous, no rattrapage)", () => {
  it("days 12, 13, 17 contributed → descending list with missings in between", () => {
    const transactions: JournalTransaction[] = [
      makeTx({ kind: "contribution", cycleId: CYCLE_PREV.id, cycleDay: 12 }),
      makeTx({ kind: "contribution", cycleId: CYCLE_PREV.id, cycleDay: 13 }),
      makeTx({ kind: "contribution", cycleId: CYCLE_PREV.id, cycleDay: 17 }),
    ];
    const rows = buildJournalDayRows({
      transactions,
      period: "cycle_previous",
      member,
      // Run "today" on the day AFTER cycle previous ended so the full
      // contribution range (days 1..29) is visible.
      todayIso: "2026-05-01",
    });

    // Cycle previous = days 1..29 (commission = day 30 skipped).
    // Days 17, 13, 12 = contribution; the rest = missing.
    expect(rows).toHaveLength(29);
    expect(rows.map((r) => r.cycleDay)).toEqual(
      Array.from({ length: 29 }, (_, i) => 29 - i), // 29, 28, …, 1
    );
    const contributedDays = rows.filter((r) => r.kind === "contribution").map((r) => r.cycleDay);
    expect(contributedDays).toEqual([17, 13, 12]);
    const missingCount = rows.filter((r) => r.kind === "missing").length;
    expect(missingCount).toBe(29 - 3);
  });
});

// ---------------------------------------------------------------------------
// Rattrapage forward-coverage suppression.
// ---------------------------------------------------------------------------

describe("buildJournalDayRows — rattrapage suppression", () => {
  it("rattrapage on day 10 with days_covered=3 → day 10 row, days 11/12 omitted", () => {
    const transactions: JournalTransaction[] = [
      makeTx({ kind: "rattrapage", cycleId: CYCLE_PREV.id, cycleDay: 10, daysCovered: 3 }),
    ];
    const rows = buildJournalDayRows({
      transactions,
      period: "cycle_previous",
      member,
      todayIso: "2026-05-01",
    });

    // Cycle days 1..29 minus the suppressed 11, 12 = 27 rows.
    expect(rows).toHaveLength(27);

    const cycleDays = rows.map((r) => r.cycleDay);
    expect(cycleDays).not.toContain(11);
    expect(cycleDays).not.toContain(12);
    expect(cycleDays).toContain(10);

    const day10 = rows.find((r) => r.cycleDay === 10);
    expect(day10?.kind).toBe("rattrapage");
    expect(day10?.daysCovered).toBe(3);
  });

  it("rattrapage with days_covered=2 suppresses only the next 1 day", () => {
    const transactions: JournalTransaction[] = [
      makeTx({ kind: "rattrapage", cycleId: CYCLE_PREV.id, cycleDay: 5, daysCovered: 2 }),
    ];
    const rows = buildJournalDayRows({
      transactions,
      period: "cycle_previous",
      member,
      todayIso: "2026-05-01",
    });
    const days = rows.map((r) => r.cycleDay);
    expect(days).toContain(5);
    expect(days).not.toContain(6);
    expect(days).toContain(7);
  });
});

// ---------------------------------------------------------------------------
// Advance day.
// ---------------------------------------------------------------------------

describe("buildJournalDayRows — advance day", () => {
  it("day with only an advance → advance row (no missing-day warning)", () => {
    const transactions: JournalTransaction[] = [
      makeTx({ kind: "advance", cycleId: CYCLE_PREV.id, cycleDay: 7 }),
    ];
    const rows = buildJournalDayRows({
      transactions,
      period: "cycle_previous",
      member,
      todayIso: "2026-05-01",
    });
    const day7 = rows.find((r) => r.cycleDay === 7);
    expect(day7?.kind).toBe("advance");
  });

  it("day with BOTH a contribution AND an advance → BOTH rows emitted (no precedence drop)", () => {
    // Regression guard — the pre-2026-06 builder dropped the advance via an
    // if/else if precedence pick, which silently hid the advance from the
    // journal even though the saver clearly made it. Now every transaction
    // gets its own row.
    const transactions: JournalTransaction[] = [
      // Contribution at 10:00, advance at 14:00 — same cycle-day.
      {
        ...makeTx({ kind: "contribution", cycleId: CYCLE_PREV.id, cycleDay: 5 }),
        createdAt: "2026-04-05T10:00:00Z",
      },
      {
        ...makeTx({ kind: "advance", cycleId: CYCLE_PREV.id, cycleDay: 5 }),
        createdAt: "2026-04-05T14:00:00Z",
      },
    ];
    const rows = buildJournalDayRows({
      transactions,
      period: "cycle_previous",
      member,
      todayIso: "2026-05-01",
    });
    const day5Rows = rows.filter((r) => r.cycleDay === 5);
    expect(day5Rows).toHaveLength(2);
    // Most-recent-first within the same day → advance (14:00) before contribution (10:00).
    expect(day5Rows.map((r) => r.kind)).toEqual(["advance", "contribution"]);
    // Day 5 contributes 2 visible rows + 28 missings for the rest of cycle = 30 total.
    expect(rows).toHaveLength(30);
  });

  it("day with BOTH a contribution AND a rattrapage → BOTH rows emitted (Ndeye Marieme prod case)", () => {
    // Real prod-bug shape: cycle_day 6 had a 30k contribution at 01:30 then
    // a 120k rattrapage at 02:02 on the SAME calendar day. Pre-fix, only the
    // contribution rendered and the 120k rattrapage was invisible — exactly
    // what made "À régler: 240 000" look unexplainable in the dashboard.
    const transactions: JournalTransaction[] = [
      {
        ...makeTx({ kind: "contribution", cycleId: CYCLE_PREV.id, cycleDay: 6, amount: 30000 }),
        createdAt: "2026-04-06T01:30:00Z",
      },
      {
        ...makeTx({
          kind: "rattrapage",
          cycleId: CYCLE_PREV.id,
          cycleDay: 6,
          daysCovered: 4,
          amount: 120000,
        }),
        createdAt: "2026-04-06T02:02:00Z",
      },
    ];
    const rows = buildJournalDayRows({
      transactions,
      period: "cycle_previous",
      member,
      todayIso: "2026-05-01",
    });
    const day6Rows = rows.filter((r) => r.cycleDay === 6);
    expect(day6Rows).toHaveLength(2);
    // Rattrapage at 02:02 sorts before contribution at 01:30 in desc order.
    expect(day6Rows[0]?.kind).toBe("rattrapage");
    expect(day6Rows[0]?.daysCovered).toBe(4);
    expect(day6Rows[1]?.kind).toBe("contribution");
    // Suppression still applies — cycle-days 7, 8, 9 don't emit missing rows.
    const cycleDays = rows.map((r) => r.cycleDay);
    expect(cycleDays).not.toContain(7);
    expect(cycleDays).not.toContain(8);
    expect(cycleDays).not.toContain(9);
  });
});

// ---------------------------------------------------------------------------
// Commission day + future days never appear.
// ---------------------------------------------------------------------------

describe("buildJournalDayRows — boundary rules", () => {
  it("commission day (cycle_day === cycleLength) never appears in the output", () => {
    const transactions: JournalTransaction[] = [];
    const rows = buildJournalDayRows({
      transactions,
      period: "cycle_previous",
      member,
      todayIso: "2026-05-01",
    });
    const days = rows.map((r) => r.cycleDay);
    expect(days).not.toContain(30);
  });

  it("future days (cycle_current beyond today) never appear", () => {
    const transactions: JournalTransaction[] = [];
    const rows = buildJournalDayRows({
      transactions,
      period: "cycle_current",
      member,
      // Today = 2026-05-10 → cycle day 10. Only days 1..10 should appear.
      todayIso: "2026-05-10",
    });
    expect(rows.map((r) => r.cycleDay)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(rows.every((r) => r.kind === "missing")).toBe(true);
  });

  it("cycle_current with today === startDate → exactly one missing row (day 1)", () => {
    const rows = buildJournalDayRows({
      transactions: [],
      period: "cycle_current",
      member,
      todayIso: "2026-05-01",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cycleDay).toBe(1);
    expect(rows[0]?.kind).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// last_seven_days — rolling window, cross-cycle, skips days outside cycles.
// ---------------------------------------------------------------------------

describe("buildJournalDayRows — last_seven_days", () => {
  it("rolling window spanning previous + current cycle (gap days outside cycles skipped)", () => {
    // Today = 2026-05-03 → window = 2026-04-27 .. 2026-05-03.
    // CYCLE_PREV ends 2026-04-30 (commission), last contribution = 2026-04-29.
    // CYCLE_CURR starts 2026-05-01.
    // Expected days in calendar: 2026-05-03, 02, 01 (current cycle 3, 2, 1)
    // + 2026-04-29, 28, 27 (previous cycle 29, 28, 27). Day 2026-04-30 is the
    // previous cycle's commission day → skipped.
    const transactions: JournalTransaction[] = [
      makeTx({ kind: "contribution", cycleId: CYCLE_CURR.id, cycleDay: 2 }),
      makeTx({ kind: "contribution", cycleId: CYCLE_PREV.id, cycleDay: 29 }),
    ];
    const rows = buildJournalDayRows({
      transactions,
      period: "last_seven_days",
      member,
      todayIso: "2026-05-03",
    });
    expect(kindsByDate(rows)).toEqual([
      { date: "2026-05-03", kind: "missing" },
      { date: "2026-05-02", kind: "contribution" },
      { date: "2026-05-01", kind: "missing" },
      // 2026-04-30 = commission day of CYCLE_PREV → omitted.
      { date: "2026-04-29", kind: "contribution" },
      { date: "2026-04-28", kind: "missing" },
      { date: "2026-04-27", kind: "missing" },
    ]);
  });

  it("last_seven_days where some window days fall before cycle 1 → those days are skipped", () => {
    // Member's only cycle is CYCLE_CURR (no previous). Today = 2026-05-04
    // → window 2026-04-28..2026-05-04. Days 2026-04-28/29/30 fall outside
    // any cycle (member did not exist yet).
    const memberFresh = { currentCycle: CYCLE_CURR, previousCycle: null };
    const rows = buildJournalDayRows({
      transactions: [],
      period: "last_seven_days",
      member: memberFresh,
      todayIso: "2026-05-04",
    });
    expect(rows.map((r) => r.date)).toEqual([
      "2026-05-04",
      "2026-05-03",
      "2026-05-02",
      "2026-05-01",
    ]);
    expect(rows.every((r) => r.kind === "missing")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No cycle on file → empty output.
// ---------------------------------------------------------------------------

describe("buildJournalDayRows — empty cases", () => {
  it("cycle_previous with no previous cycle → empty array", () => {
    const rows = buildJournalDayRows({
      transactions: [],
      period: "cycle_previous",
      member: { currentCycle: CYCLE_CURR, previousCycle: null },
      todayIso: "2026-05-10",
    });
    expect(rows).toEqual([]);
  });

  it("cycle_current with no current cycle → empty array", () => {
    const rows = buildJournalDayRows({
      transactions: [],
      period: "cycle_current",
      member: { currentCycle: null, previousCycle: CYCLE_PREV },
      todayIso: "2026-05-10",
    });
    expect(rows).toEqual([]);
  });
});
