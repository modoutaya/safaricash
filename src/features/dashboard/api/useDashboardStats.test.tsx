// Story 9.1 — useDashboardStats tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMBERS_QUERY_KEY, type MemberWithMeta } from "@/features/member";

import type { DashboardTxRow } from "./deriveDashboardStats";
import {
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
};

// `created_at` is "now" so the deriveDashboardStats today-filter includes it
// regardless of the run date.
const TODAY_TX: DashboardTxRow = {
  id: "tx-today",
  member_id: MEMBER.id,
  kind: "contribution",
  amount: 500,
  created_at: new Date().toISOString(),
};

describe("useDashboardStats", () => {
  it("polls every 60 seconds (architecture Q-ARCH6)", () => {
    expect(DASHBOARD_POLL_INTERVAL_MS).toBe(60_000);
  });

  it("offline + pre-seeded caches → derives the stats without erroring", () => {
    setOnline(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(MEMBERS_QUERY_KEY, [MEMBER]);
    // The hook date-stamps the query key — seed the same date-stamped key.
    const todayKey = new Date().toISOString().slice(0, 10);
    client.setQueryData([...DASHBOARD_QUERY_KEY, todayKey], {
      today: [TODAY_TX],
      recent: [TODAY_TX],
    });

    const { result } = renderHook(() => useDashboardStats(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    });

    expect(result.current.isError).toBe(false);
    expect(result.current.stats.activeMembersCount).toBe(1);
    expect(result.current.stats.commissionThisCycle).toBe(500);
    expect(result.current.stats.todayCollected).toBe(500);
    expect(result.current.stats.recentActivity).toHaveLength(1);
  });
});
