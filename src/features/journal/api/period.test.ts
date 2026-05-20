// Story 12.1 — JournalPeriod bounds resolution.

import { describe, expect, it } from "vitest";

import { resolveJournalPeriodBounds } from "./period";

const memberWithBoth = {
  currentCycle: {
    id: "c2",
    cycleNumber: 2,
    startDate: "2026-05-01",
    endDate: "2026-05-30",
  },
  previousCycle: {
    id: "c1",
    cycleNumber: 1,
    startDate: "2026-04-01",
    endDate: "2026-04-30",
  },
};

describe("resolveJournalPeriodBounds", () => {
  it("cycle_previous → previous cycle bounds in ISO timestamps", () => {
    const bounds = resolveJournalPeriodBounds("cycle_previous", memberWithBoth);
    expect(bounds).toEqual({
      fromIso: "2026-04-01T00:00:00Z",
      toIso: "2026-04-30T23:59:59.999Z",
    });
  });

  it("cycle_current → current cycle bounds in ISO timestamps", () => {
    const bounds = resolveJournalPeriodBounds("cycle_current", memberWithBoth);
    expect(bounds).toEqual({
      fromIso: "2026-05-01T00:00:00Z",
      toIso: "2026-05-30T23:59:59.999Z",
    });
  });

  it("last_two_days → rolling 48h window ending at `now`", () => {
    const now = new Date("2026-05-20T18:00:00Z");
    const bounds = resolveJournalPeriodBounds("last_two_days", memberWithBoth, now);
    expect(bounds).toEqual({
      fromIso: "2026-05-18T18:00:00.000Z",
      toIso: "2026-05-20T18:00:00.000Z",
    });
  });

  it("cycle_previous on a member with no previous cycle → null", () => {
    const bounds = resolveJournalPeriodBounds("cycle_previous", {
      currentCycle: memberWithBoth.currentCycle,
      previousCycle: null,
    });
    expect(bounds).toBeNull();
  });

  it("cycle_current on a member with no current cycle → null", () => {
    const bounds = resolveJournalPeriodBounds("cycle_current", {
      currentCycle: null,
      previousCycle: memberWithBoth.previousCycle,
    });
    expect(bounds).toBeNull();
  });

  it("last_two_days never returns null (no member-state dependency)", () => {
    const bounds = resolveJournalPeriodBounds("last_two_days", {
      currentCycle: null,
      previousCycle: null,
    });
    expect(bounds).not.toBeNull();
  });
});
