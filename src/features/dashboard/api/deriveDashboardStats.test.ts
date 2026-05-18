// Story 9.1 — deriveDashboardStats tests.

import { describe, expect, it } from "vitest";

import type { MemberWithMeta } from "@/features/member";

import { deriveDashboardStats, type DashboardTxRow } from "./deriveDashboardStats";

function member(overrides: Partial<MemberWithMeta>): MemberWithMeta {
  return {
    id: crypto.randomUUID(),
    name: "Member",
    phoneNumber: "+221770000000",
    dailyAmount: 500,
    displayStatus: "actif",
    currentCycle: null,
    latestInteractionAt: "2026-05-15T00:00:00.000Z",
    cycleAdvancesTotal: 0,
    projectedBalance: null,
    ...overrides,
  };
}

function tx(overrides: Partial<DashboardTxRow>): DashboardTxRow {
  return {
    id: crypto.randomUUID(),
    member_id: crypto.randomUUID(),
    kind: "contribution",
    amount: 500,
    created_at: "2026-05-15T08:00:00.000000Z",
    ...overrides,
  };
}

describe("deriveDashboardStats", () => {
  it("empty data → all-zero stats + empty activity", () => {
    const s = deriveDashboardStats([], [], []);
    expect(s).toEqual({
      activeMembersCount: 0,
      cycleCollected: 0,
      commissionThisCycle: 0,
      recentActivity: [],
    });
  });

  it("active-members count excludes finished (termine) members", () => {
    const s = deriveDashboardStats(
      [
        member({ displayStatus: "actif" }),
        member({ displayStatus: "avance" }),
        member({ displayStatus: "termine" }),
      ],
      [],
      [],
    );
    expect(s.activeMembersCount).toBe(2);
  });

  it("commission = Σ commission(dailyAmount) over active members only", () => {
    const s = deriveDashboardStats(
      [
        member({ displayStatus: "actif", dailyAmount: 500 }),
        member({ displayStatus: "avance", dailyAmount: 1000 }),
        member({ displayStatus: "termine", dailyAmount: 2000 }),
      ],
      [],
      [],
    );
    // commission() = dailyAmount × 1 — termine member excluded.
    expect(s.commissionThisCycle).toBe(1500);
  });

  it("cycleCollected sums contribution + rattrapage amounts", () => {
    const s = deriveDashboardStats(
      [],
      [tx({ kind: "contribution", amount: 500 }), tx({ kind: "rattrapage", amount: 1500 })],
      [],
    );
    expect(s.cycleCollected).toBe(2000);
  });

  it("cycleCollected EXCLUDES advance transactions (money out, not collected)", () => {
    const s = deriveDashboardStats(
      [],
      [tx({ kind: "contribution", amount: 500 }), tx({ kind: "advance", amount: 10000 })],
      [],
    );
    expect(s.cycleCollected).toBe(500);
  });

  it("recentActivity is sorted newest-first and capped at 5", () => {
    // Distinct timestamps, supplied in NON-descending order.
    const rows = [
      tx({ amount: 100, created_at: "2026-05-15T01:00:00.000000Z" }),
      tx({ amount: 700, created_at: "2026-05-15T07:00:00.000000Z" }),
      tx({ amount: 300, created_at: "2026-05-15T03:00:00.000000Z" }),
      tx({ amount: 600, created_at: "2026-05-15T06:00:00.000000Z" }),
      tx({ amount: 200, created_at: "2026-05-15T02:00:00.000000Z" }),
      tx({ amount: 500, created_at: "2026-05-15T05:00:00.000000Z" }),
      tx({ amount: 400, created_at: "2026-05-15T04:00:00.000000Z" }),
    ];
    const s = deriveDashboardStats([], [], rows);
    expect(s.recentActivity).toHaveLength(5);
    // Newest-first: 07:00 then 06:00 — the two oldest (01:00, 02:00) dropped.
    expect(s.recentActivity[0]!.amount).toBe(700);
    expect(s.recentActivity[1]!.amount).toBe(600);
    expect(s.recentActivity.map((a) => a.amount)).not.toContain(100);
    expect(s.recentActivity.map((a) => a.amount)).not.toContain(200);
  });

  it("recentActivity returns all rows when fewer than 5", () => {
    const s = deriveDashboardStats([], [], [tx({}), tx({})]);
    expect(s.recentActivity).toHaveLength(2);
  });

  it("recentActivity maps id / kind / memberId / amount / createdAt", () => {
    const row = tx({
      id: "tx-1",
      kind: "advance",
      member_id: "mem-1",
      amount: 7000,
      created_at: "2026-05-15T09:30:00.000000Z",
    });
    const s = deriveDashboardStats([], [], [row]);
    expect(s.recentActivity[0]).toEqual({
      id: "tx-1",
      kind: "advance",
      memberId: "mem-1",
      amount: 7000,
      createdAt: "2026-05-15T09:30:00.000000Z",
    });
  });
});
