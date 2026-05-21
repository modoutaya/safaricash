// Story 3.5 — selector unit tests.
//
// Pure function — no I/O, no React. Cases mirror AC #12 in the story spec.

import { describe, expect, it } from "vitest";

import type { MemberWithMeta } from "@/features/member";

import { selectMembersWithCycleEndingSoon } from "./selectMembersWithCycleEndingSoon";

function mkMember(
  override: Partial<MemberWithMeta> & Pick<MemberWithMeta, "id" | "name">,
): MemberWithMeta {
  return {
    phoneNumber: null,
    dailyAmount: 500,
    displayStatus: "actif",
    currentCycle: {
      id: "cycle-1",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      cycleLength: 30,
      dayNumber: 25,
      openingBalance: 0,
    },
    latestInteractionAt: "2026-04-25T12:00:00Z",
    cycleAdvancesTotal: 0,
    projectedBalance: null,
    awaitingSettlement: null,
    lastSettlementAt: null,
    ...override,
  };
}

describe("selectMembersWithCycleEndingSoon", () => {
  it("empty input → []", () => {
    expect(selectMembersWithCycleEndingSoon([], 7)).toEqual([]);
  });

  it("all members termine → []", () => {
    const members = [
      mkMember({ id: "m1", name: "A", displayStatus: "termine" }),
      mkMember({ id: "m2", name: "B", displayStatus: "termine" }),
    ];
    expect(selectMembersWithCycleEndingSoon(members, 7)).toEqual([]);
  });

  it("mix of in-window / out-of-window / null cycle / termine — keeps in-window non-termine, preserves order", () => {
    const inWindow = mkMember({
      id: "in1",
      name: "InWindow1",
      currentCycle: {
        id: "c-in1",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        cycleLength: 30,
        dayNumber: 25,
        openingBalance: 0,
      },
    });
    const outOfWindow = mkMember({
      id: "out1",
      name: "OutOfWindow",
      currentCycle: {
        id: "c-out",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        cycleLength: 30,
        dayNumber: 10,
        openingBalance: 0,
      },
    });
    const nullCycle = mkMember({ id: "null1", name: "NullCycle", currentCycle: null });
    const termine = mkMember({
      id: "t1",
      name: "Termine",
      displayStatus: "termine",
      currentCycle: {
        id: "c-t",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        cycleLength: 30,
        dayNumber: 30,
        openingBalance: 0,
      },
    });
    const inWindow2 = mkMember({
      id: "in2",
      name: "InWindow2",
      currentCycle: {
        id: "c-in2",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        cycleLength: 30,
        dayNumber: 30,
        openingBalance: 0,
      },
    });

    const result = selectMembersWithCycleEndingSoon(
      [inWindow, outOfWindow, nullCycle, termine, inWindow2],
      7,
    );

    expect(result.map((m) => m.id)).toEqual(["in1", "in2"]);
  });

  it("window = 0 → only members at day 30 match", () => {
    const day29 = mkMember({
      id: "29",
      name: "Day29",
      currentCycle: {
        id: "c-29",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        cycleLength: 30,
        dayNumber: 29,
        openingBalance: 0,
      },
    });
    const day30 = mkMember({
      id: "30",
      name: "Day30",
      currentCycle: {
        id: "c-30",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        cycleLength: 30,
        dayNumber: 30,
        openingBalance: 0,
      },
    });
    expect(selectMembersWithCycleEndingSoon([day29, day30], 0).map((m) => m.id)).toEqual(["30"]);
  });

  it("window = 30 → all members with an active currentCycle match", () => {
    const day1 = mkMember({
      id: "1",
      name: "Day1",
      currentCycle: {
        id: "c-1",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        cycleLength: 30,
        dayNumber: 1,
        openingBalance: 0,
      },
    });
    const day30 = mkMember({
      id: "30",
      name: "Day30",
      currentCycle: {
        id: "c-30",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        cycleLength: 30,
        dayNumber: 30,
        openingBalance: 0,
      },
    });
    const nullC = mkMember({ id: "null", name: "Null", currentCycle: null });
    expect(selectMembersWithCycleEndingSoon([day1, day30, nullC], 30).map((m) => m.id)).toEqual([
      "1",
      "30",
    ]);
  });
});
