// Story 12.1 — pure derive transform for the journal member list.
// (The async fetch is covered indirectly by the JournalPage E2E.)

import { describe, expect, it } from "vitest";

import type { CycleRow, MemberRow } from "@/features/member";

import { deriveJournalMembers } from "./useJournalMembers";

const makeMemberRow = (id: string, name: string): MemberRow => ({
  id,
  collector_id: "00000000-0000-4000-8000-000000000001",
  name,
  phone_number: null,
  daily_amount: 500,
  status: "active",
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  sms_opt_out: false,
});

const makeCycle = (
  id: string,
  cycleNumber: number,
  startDate: string,
  endDate: string,
  status: CycleRow["status"] = "active",
): CycleRow & { member_id: string } => ({
  id,
  member_id: "",
  cycle_number: cycleNumber,
  start_date: startDate,
  end_date: endDate,
  status,
});

describe("deriveJournalMembers", () => {
  it("picks the highest-numbered active cycle as current; previous = current-1", () => {
    const member = makeMemberRow("m1", "Khadim");
    const cycles = new Map<string, (CycleRow & { member_id: string })[]>([
      [
        "m1",
        [
          { ...makeCycle("c1", 1, "2026-04-01", "2026-04-30", "completed"), member_id: "m1" },
          { ...makeCycle("c2", 2, "2026-05-01", "2026-05-30", "active"), member_id: "m1" },
        ],
      ],
    ]);
    const latest = new Map<string, string>([["m1", "2026-05-19T10:00:00Z"]]);
    const [j] = deriveJournalMembers([member], cycles, latest);
    expect(j?.currentCycle?.id).toBe("c2");
    expect(j?.previousCycle?.id).toBe("c1");
    expect(j?.lastActivityAt).toBe("2026-05-19T10:00:00Z");
  });

  it("member with only cycle #1 → previousCycle null", () => {
    const member = makeMemberRow("m1", "Khadim");
    const cycles = new Map<string, (CycleRow & { member_id: string })[]>([
      ["m1", [{ ...makeCycle("c1", 1, "2026-05-20", "2026-05-30", "active"), member_id: "m1" }]],
    ]);
    const [j] = deriveJournalMembers([member], cycles, new Map());
    expect(j?.currentCycle?.id).toBe("c1");
    expect(j?.previousCycle).toBeNull();
    expect(j?.lastActivityAt).toBeNull();
  });

  it("member with no active cycle → previousCycle = most recent settled/completed", () => {
    const member = makeMemberRow("m1", "Khadim");
    const cycles = new Map<string, (CycleRow & { member_id: string })[]>([
      [
        "m1",
        [
          { ...makeCycle("c1", 1, "2026-04-01", "2026-04-30", "completed"), member_id: "m1" },
          { ...makeCycle("c2", 2, "2026-05-01", "2026-05-30", "settled"), member_id: "m1" },
        ],
      ],
    ]);
    const [j] = deriveJournalMembers([member], cycles, new Map());
    expect(j?.currentCycle).toBeNull();
    expect(j?.previousCycle?.id).toBe("c2");
  });

  it("member with zero cycles on file → both null", () => {
    const member = makeMemberRow("m1", "Khadim");
    const [j] = deriveJournalMembers([member], new Map(), new Map());
    expect(j?.currentCycle).toBeNull();
    expect(j?.previousCycle).toBeNull();
  });
});
