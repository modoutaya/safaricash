// Story 3.5 — useCyclesEndingAlert hook tests.
//
// Wraps in QueryClientProvider + seeded MEMBERS_QUERY_KEY data per the
// Story 2.4 pattern. The supabase RPC is stubbed at the module level so
// fetchRawMembersData never runs — the seeded cache short-circuits the
// query and useMembers returns the seeded view-model directly.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MEMBERS_QUERY_KEY, type MemberWithMeta } from "@/features/member";

vi.mock("@/infrastructure/supabase/client", () => ({
  // useMembers calls supabase.from(...).select(...).order(...) but the
  // QueryClient cache hit short-circuits the network call. The stub is
  // here purely so any escaping import doesn't blow up at module load.
  supabase: {
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  },
}));

import { useCyclesEndingAlert } from "./useCyclesEndingAlert";

function mkMember(
  override: Partial<MemberWithMeta> & Pick<MemberWithMeta, "id" | "name">,
): MemberWithMeta {
  return {
    phoneNumber: null,
    dailyAmount: 500,
    displayStatus: "actif",
    currentCycle: {
      id: "c1",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      cycleLength: 30,
      dayNumber: 25,
    },
    latestInteractionAt: "2026-04-25T12:00:00Z",
    cycleAdvancesTotal: 0,
    projectedBalance: null,
    ...override,
  };
}

function makeWrapper(seedData?: MemberWithMeta[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  if (seedData !== undefined) {
    client.setQueryData(MEMBERS_QUERY_KEY, seedData);
  }
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { Wrapper, client };
}

describe("useCyclesEndingAlert", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("count > 0 + not dismissed → returns count + members + isDismissed=false", () => {
    const { Wrapper } = makeWrapper([
      mkMember({ id: "1", name: "A" }),
      mkMember({ id: "2", name: "B" }),
      mkMember({
        id: "3",
        name: "Out",
        currentCycle: {
          id: "c",
          startDate: "2026-04-01",
          endDate: "2026-04-30",
          cycleLength: 30,
          dayNumber: 5,
        },
      }),
    ]);

    const { result } = renderHook(() => useCyclesEndingAlert(), { wrapper: Wrapper });

    expect(result.current.count).toBe(2);
    expect(result.current.members.map((m) => m.id)).toEqual(["1", "2"]);
    expect(result.current.isDismissed).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("sessionStorage flag pre-set on mount → isDismissed=true", () => {
    sessionStorage.setItem("sc_cycle_ending_alert_dismissed", "1");
    const { Wrapper } = makeWrapper([mkMember({ id: "1", name: "A" })]);

    const { result } = renderHook(() => useCyclesEndingAlert(), { wrapper: Wrapper });

    expect(result.current.isDismissed).toBe(true);
  });

  it("dismiss() flips isDismissed AND writes the sessionStorage flag", () => {
    const { Wrapper } = makeWrapper([mkMember({ id: "1", name: "A" })]);

    const { result } = renderHook(() => useCyclesEndingAlert(), { wrapper: Wrapper });

    expect(result.current.isDismissed).toBe(false);
    expect(sessionStorage.getItem("sc_cycle_ending_alert_dismissed")).toBeNull();

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.isDismissed).toBe(true);
    expect(sessionStorage.getItem("sc_cycle_ending_alert_dismissed")).toBe("1");
  });

  it("useMembers cache miss → isLoading=true with empty count + members", () => {
    // No setQueryData → useMembers triggers the queryFn (stubbed to return
    // an empty list above), but until it resolves, the hook reports
    // isLoading=true.
    const { Wrapper } = makeWrapper(undefined);

    const { result } = renderHook(() => useCyclesEndingAlert(), { wrapper: Wrapper });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.count).toBe(0);
    expect(result.current.members).toEqual([]);
  });

  it("dismiss() reference is stable across renders (useCallback contract)", () => {
    const { Wrapper } = makeWrapper([mkMember({ id: "1", name: "A" })]);

    const { result, rerender } = renderHook(() => useCyclesEndingAlert(), { wrapper: Wrapper });
    const dismissRef1 = result.current.dismiss;
    rerender();
    const dismissRef2 = result.current.dismiss;

    expect(dismissRef1).toBe(dismissRef2);
  });
});
