// Story 9.1 — useDashboardStats tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMBERS_QUERY_KEY, type MemberWithMeta } from "@/features/member";

import type { DashboardTxRow } from "./deriveDashboardStats";
import {
  currentMonthStartIso,
  DASHBOARD_POLL_INTERVAL_MS,
  DASHBOARD_QUERY_KEY,
  useDashboardStats,
} from "./useDashboardStats";

const onlineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

beforeEach(() => setOnline(true));
afterEach(() => {
  if (onlineDescriptor) Object.defineProperty(window.navigator, "onLine", onlineDescriptor);
});

const MEMBER: MemberWithMeta = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Awa",
  phoneNumber: "+221770000000",
  dailyAmount: 500,
  displayStatus: "actif",
  currentCycle: null,
  latestInteractionAt: "2026-05-15T00:00:00.000Z",
  cycleAdvancesTotal: 0,
  projectedBalance: null,
  awaitingSettlement: null,
  lastSettlementAt: null,
};

const COLLECTED_TX: DashboardTxRow = {
  id: "tx-collected",
  member_id: MEMBER.id,
  kind: "contribution",
  amount: 500,
  created_at: "2026-05-15T08:00:00.000Z",
};

describe("useDashboardStats", () => {
  it("polls every 60 seconds (architecture Q-ARCH6)", () => {
    expect(DASHBOARD_POLL_INTERVAL_MS).toBe(60_000);
  });

  it("currentMonthStartIso → 1st of the month at 00:00 UTC", () => {
    expect(currentMonthStartIso(new Date("2026-06-08T13:59:00.000Z"))).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(currentMonthStartIso(new Date("2026-01-31T23:59:59.000Z"))).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    // Already the 1st at midnight → unchanged.
    expect(currentMonthStartIso(new Date("2026-12-01T00:00:00.000Z"))).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  it("offline + pre-seeded caches → derives the stats without erroring", () => {
    setOnline(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(MEMBERS_QUERY_KEY, [MEMBER]);
    // 2026-06-08 — the collected query is now scoped by month-start, not
    // cycle ids; seed the matching month-keyed query key.
    client.setQueryData([...DASHBOARD_QUERY_KEY, currentMonthStartIso()], {
      collected: [COLLECTED_TX],
      recent: [COLLECTED_TX],
    });

    const { result } = renderHook(() => useDashboardStats(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });

    expect(result.current.isError).toBe(false);
    expect(result.current.stats.activeMembersCount).toBe(1);
    expect(result.current.stats.commissionThisCycle).toBe(500);
    expect(result.current.stats.cycleCollected).toBe(500);
    expect(result.current.stats.recentActivity).toHaveLength(1);
  });
});
