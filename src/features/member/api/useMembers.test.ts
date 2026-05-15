// Story 2.1 — tests for the pure derivation used by useMembers.
// The TanStack/Supabase integration path is exercised indirectly via the
// MemberList component test + the Playwright E2E; here we pin the
// derivation contract on its own so failures localise immediately.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { MEMBERS_QUERY_KEY, type CycleRow, type MemberRow, type MemberWithMeta } from "../types";
import { deriveMembersWithMeta, useMembers, type RawMembersData } from "./useMembers";

const NOW = new Date("2026-04-21T12:00:00Z");
const TODAY_MINUS_10 = "2026-04-11"; // cycle day 11 at NOW

const baseMember: MemberRow = {
  id: "11111111-1111-4111-8111-111111111111",
  collector_id: "22222222-2222-4222-8222-222222222222",
  name: "Fatou Ndiaye",
  phone_number: "+221770000001",
  daily_amount: 500,
  status: "active",
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-10T00:00:00Z",
  sms_opt_out: false,
};

const activeCycle: CycleRow = {
  id: "c1",
  cycle_number: 1,
  start_date: TODAY_MINUS_10,
  end_date: "2026-05-10",
  status: "active",
};

function makeData(overrides: Partial<RawMembersData> = {}): RawMembersData {
  return {
    members: [baseMember],
    cyclesByMember: new Map([[baseMember.id, [activeCycle]]]),
    latestTxByMember: new Map([[baseMember.id, "2026-04-20T10:00:00Z"]]),
    ...overrides,
  };
}

describe("deriveMembersWithMeta", () => {
  it("maps a single active member to a visible MemberWithMeta", () => {
    const out = deriveMembersWithMeta(makeData(), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: baseMember.id,
      name: "Fatou Ndiaye",
      phoneNumber: "+221770000001",
      dailyAmount: 500,
      displayStatus: "actif",
      currentCycle: { id: "c1", startDate: TODAY_MINUS_10, dayNumber: 11 },
      latestInteractionAt: "2026-04-20T10:00:00Z",
    });
  });

  it("falls back to members.created_at when no transactions exist", () => {
    const out = deriveMembersWithMeta(makeData({ latestTxByMember: new Map() }), NOW);
    expect(out[0]!.latestInteractionAt).toBe(baseMember.created_at);
  });

  it("filters out deleted + paused members", () => {
    const members: MemberRow[] = [
      { ...baseMember, id: "a", status: "deleted" },
      { ...baseMember, id: "b", status: "paused" },
      { ...baseMember, id: "c", status: "active" },
    ];
    const cyclesByMember = new Map([["c", [activeCycle]]]);
    const out = deriveMembersWithMeta(
      makeData({ members, cyclesByMember, latestTxByMember: new Map() }),
      NOW,
    );
    expect(out.map((r) => r.id)).toEqual(["c"]);
  });

  it("maps with_advance cycle to displayStatus='avance'", () => {
    const out = deriveMembersWithMeta(
      makeData({
        cyclesByMember: new Map([[baseMember.id, [{ ...activeCycle, status: "with_advance" }]]]),
      }),
      NOW,
    );
    expect(out[0]!.displayStatus).toBe("avance");
  });

  it("maps members.status='completed' to displayStatus='termine' even with an active cycle", () => {
    const out = deriveMembersWithMeta(
      makeData({ members: [{ ...baseMember, status: "completed" }] }),
      NOW,
    );
    expect(out[0]!.displayStatus).toBe("termine");
  });

  it("returns null currentCycle when no active/with_advance cycle exists", () => {
    const out = deriveMembersWithMeta(
      makeData({
        members: [{ ...baseMember, status: "completed" }],
        cyclesByMember: new Map([[baseMember.id, [{ ...activeCycle, status: "completed" }]]]),
      }),
      NOW,
    );
    expect(out[0]!.currentCycle).toBeNull();
  });

  it("picks the cycle with the highest cycle_number when multiple qualify", () => {
    const out = deriveMembersWithMeta(
      makeData({
        cyclesByMember: new Map([
          [
            baseMember.id,
            [
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
          ],
        ]),
      }),
      NOW,
    );
    expect(out[0]!.currentCycle!.id).toBe("new");
  });

  it("sorts the output by recency (latest interaction DESC)", () => {
    const members: MemberRow[] = [
      { ...baseMember, id: "A" },
      { ...baseMember, id: "B" },
      { ...baseMember, id: "C" },
    ];
    const latestTxByMember = new Map([
      ["A", "2026-04-18T00:00:00Z"],
      ["B", "2026-04-20T00:00:00Z"],
      ["C", "2026-04-19T00:00:00Z"],
    ]);
    const cyclesByMember = new Map(members.map((m) => [m.id, [activeCycle]]));
    const out = deriveMembersWithMeta(makeData({ members, cyclesByMember, latestTxByMember }), NOW);
    expect(out.map((r) => r.id)).toEqual(["B", "C", "A"]);
  });

  it("produces a stable ordering when timestamps tie (tertiary sort on id)", () => {
    const members: MemberRow[] = [
      { ...baseMember, id: "aaa" },
      { ...baseMember, id: "bbb" },
    ];
    const latestTxByMember = new Map([
      ["aaa", "2026-04-20T10:00:00Z"],
      ["bbb", "2026-04-20T10:00:00Z"],
    ]);
    const cyclesByMember = new Map(members.map((m) => [m.id, [activeCycle]]));
    const out = deriveMembersWithMeta(makeData({ members, cyclesByMember, latestTxByMember }), NOW);
    // Tie → createdAt tie → id lex DESC.
    expect(out.map((r) => r.id)).toEqual(["bbb", "aaa"]);
  });

  it("computes cycle day as 1-indexed from start_date (day 1 = start_date)", () => {
    const out = deriveMembersWithMeta(
      makeData({
        cyclesByMember: new Map([[baseMember.id, [{ ...activeCycle, start_date: "2026-04-21" }]]]),
      }),
      NOW,
    );
    expect(out[0]!.currentCycle!.dayNumber).toBe(1);
  });

  it("clamps cycle day to 30 when the cycle has overflowed its window", () => {
    const out = deriveMembersWithMeta(
      makeData({
        cyclesByMember: new Map([[baseMember.id, [{ ...activeCycle, start_date: "2026-01-01" }]]]),
      }),
      NOW,
    );
    expect(out[0]!.currentCycle!.dayNumber).toBe(30);
  });

  it("handles a member with no cycles at all (displays as 'actif' fallback for active status)", () => {
    const out = deriveMembersWithMeta(
      makeData({
        cyclesByMember: new Map(),
      }),
      NOW,
    );
    // Dev-warn is expected here; we don't assert on it since the pure
    // derivation test for deriveMemberStatus already covers that surface.
    expect(out[0]!.currentCycle).toBeNull();
  });
});

// Story 8.6 — offline read path: with the member-list query already in the
// cache (rehydrated by the TanStack persister), useMembers serves that data
// while offline rather than erroring on the failed fetch.
describe("useMembers — offline serves the cached/persisted data", () => {
  it("offline + a pre-seeded cache → returns the data, isError stays false", () => {
    const onlineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const seeded: MemberWithMeta[] = [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Cached Member",
          phoneNumber: "+221770000000",
          dailyAmount: 500,
          displayStatus: "actif",
          currentCycle: null,
          latestInteractionAt: "2026-05-15T00:00:00.000Z",
        },
      ];
      client.setQueryData(MEMBERS_QUERY_KEY, seeded);

      const { result } = renderHook(() => useMembers(), {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client }, children),
      });

      expect(result.current.data).toEqual(seeded);
      expect(result.current.isError).toBe(false);
    } finally {
      if (onlineDescriptor) {
        Object.defineProperty(window.navigator, "onLine", onlineDescriptor);
      }
    }
  });
});
