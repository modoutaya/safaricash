// Story 2.1 — tests for the pure derivation used by useMembers.
// The TanStack/Supabase integration path is exercised indirectly via the
// MemberList component test + the Playwright E2E; here we pin the
// derivation contract on its own so failures localise immediately.

import { describe, expect, it } from "vitest";

import type { MembersListRow } from "../types";
import { deriveMembersWithMeta } from "./useMembers";

const NOW = new Date("2026-04-21T12:00:00Z");
const TODAY_MINUS_10 = "2026-04-11"; // cycle day 11 at NOW

const baseRow: MembersListRow = {
  id: "11111111-1111-4111-8111-111111111111",
  collector_id: "22222222-2222-4222-8222-222222222222",
  name: "Fatou Ndiaye",
  phone_number: "+221770000001",
  daily_amount: 500,
  status: "active",
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-10T00:00:00Z",
  cycles: [
    {
      id: "c1",
      cycle_number: 1,
      start_date: TODAY_MINUS_10,
      end_date: "2026-05-10",
      status: "active",
    },
  ],
  transactions: [{ created_at: "2026-04-20T10:00:00Z" }],
};

describe("deriveMembersWithMeta", () => {
  it("maps a single active row to a visible MemberWithMeta", () => {
    const out = deriveMembersWithMeta([baseRow], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: baseRow.id,
      name: "Fatou Ndiaye",
      phoneNumber: "+221770000001",
      dailyAmount: 500,
      displayStatus: "actif",
      currentCycle: {
        id: "c1",
        startDate: TODAY_MINUS_10,
        dayNumber: 11,
      },
      latestInteractionAt: "2026-04-20T10:00:00Z",
    });
  });

  it("falls back to members.created_at when no transactions exist", () => {
    const row: MembersListRow = { ...baseRow, transactions: [] };
    const out = deriveMembersWithMeta([row], NOW);
    expect(out[0]!.latestInteractionAt).toBe(baseRow.created_at);
  });

  it("filters out deleted + paused members", () => {
    const rows: MembersListRow[] = [
      { ...baseRow, id: "a", status: "deleted" },
      { ...baseRow, id: "b", status: "paused" },
      { ...baseRow, id: "c", status: "active" },
    ];
    const out = deriveMembersWithMeta(rows, NOW);
    expect(out.map((r) => r.id)).toEqual(["c"]);
  });

  it("maps with_advance cycle to displayStatus='avance'", () => {
    const row: MembersListRow = {
      ...baseRow,
      cycles: [{ ...baseRow.cycles![0]!, status: "with_advance" }],
    };
    expect(deriveMembersWithMeta([row], NOW)[0]!.displayStatus).toBe("avance");
  });

  it("maps members.status='completed' to displayStatus='termine' even with an active cycle", () => {
    const row: MembersListRow = { ...baseRow, status: "completed" };
    expect(deriveMembersWithMeta([row], NOW)[0]!.displayStatus).toBe("termine");
  });

  it("returns null currentCycle when no active/with_advance cycle exists", () => {
    const row: MembersListRow = {
      ...baseRow,
      status: "completed",
      cycles: [{ ...baseRow.cycles![0]!, status: "completed" }],
    };
    const out = deriveMembersWithMeta([row], NOW);
    expect(out[0]!.currentCycle).toBeNull();
  });

  it("picks the cycle with the highest cycle_number when multiple qualify", () => {
    const row: MembersListRow = {
      ...baseRow,
      cycles: [
        {
          id: "old",
          cycle_number: 1,
          start_date: "2026-03-01",
          end_date: "2026-03-30",
          status: "active",
        },
        {
          id: "new",
          cycle_number: 2,
          start_date: TODAY_MINUS_10,
          end_date: "2026-05-10",
          status: "active",
        },
      ],
    };
    const out = deriveMembersWithMeta([row], NOW);
    expect(out[0]!.currentCycle!.id).toBe("new");
  });

  it("sorts the output by recency (latest interaction DESC)", () => {
    const rows: MembersListRow[] = [
      { ...baseRow, id: "A", transactions: [{ created_at: "2026-04-18T00:00:00Z" }] },
      { ...baseRow, id: "B", transactions: [{ created_at: "2026-04-20T00:00:00Z" }] },
      { ...baseRow, id: "C", transactions: [{ created_at: "2026-04-19T00:00:00Z" }] },
    ];
    const out = deriveMembersWithMeta(rows, NOW);
    expect(out.map((r) => r.id)).toEqual(["B", "C", "A"]);
  });

  it("produces a stable ordering when timestamps tie (tertiary sort on id)", () => {
    const rows: MembersListRow[] = [
      { ...baseRow, id: "aaa", transactions: [{ created_at: "2026-04-20T10:00:00Z" }] },
      { ...baseRow, id: "bbb", transactions: [{ created_at: "2026-04-20T10:00:00Z" }] },
    ];
    const out = deriveMembersWithMeta(rows, NOW);
    // Tie → createdAt tie → id lex DESC.
    expect(out.map((r) => r.id)).toEqual(["bbb", "aaa"]);
  });

  it("computes cycle day as 1-indexed from start_date (day 1 = start_date)", () => {
    const row: MembersListRow = {
      ...baseRow,
      cycles: [{ ...baseRow.cycles![0]!, start_date: "2026-04-21" }],
    };
    const out = deriveMembersWithMeta([row], NOW);
    expect(out[0]!.currentCycle!.dayNumber).toBe(1);
  });

  it("clamps cycle day to 30 when the cycle has overflowed its window", () => {
    const row: MembersListRow = {
      ...baseRow,
      cycles: [{ ...baseRow.cycles![0]!, start_date: "2026-01-01" }],
    };
    const out = deriveMembersWithMeta([row], NOW);
    expect(out[0]!.currentCycle!.dayNumber).toBe(30);
  });
});
