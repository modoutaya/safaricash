// Story 3.5 — useCyclesEndingAlert hook tests.
//
// Mocks `useMembers` directly via module-level vi.mock so we don't need
// to seed the TanStack Query cache for every case. Mirrors Story 2.5/2.6
// hook-test discipline.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberWithMeta } from "@/features/member";

const useMembersMock = vi.fn();

vi.mock("@/features/member/api/useMembers", () => ({
  useMembers: () => useMembersMock(),
  MEMBERS_QUERY_KEY: ["members", "list"],
}));

import { useCyclesEndingAlert } from "./useCyclesEndingAlert";

function mkMember(
  override: Partial<MemberWithMeta> & Pick<MemberWithMeta, "id" | "name">,
): MemberWithMeta {
  return {
    phoneNumber: null,
    dailyAmount: 500,
    displayStatus: "actif",
    currentCycle: { id: "c1", startDate: "2026-04-01", dayNumber: 25 },
    latestInteractionAt: "2026-04-25T12:00:00Z",
    ...override,
  };
}

describe("useCyclesEndingAlert", () => {
  beforeEach(() => {
    useMembersMock.mockReset();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("count > 0 + not dismissed → returns count + members + isDismissed=false", () => {
    useMembersMock.mockReturnValue({
      data: [
        mkMember({ id: "1", name: "A" }),
        mkMember({ id: "2", name: "B" }),
        mkMember({
          id: "3",
          name: "Out",
          currentCycle: { id: "c", startDate: "2026-04-01", dayNumber: 5 },
        }),
      ],
      isLoading: false,
    });

    const { result } = renderHook(() => useCyclesEndingAlert());

    expect(result.current.count).toBe(2);
    expect(result.current.members.map((m) => m.id)).toEqual(["1", "2"]);
    expect(result.current.isDismissed).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it("sessionStorage flag pre-set on mount → isDismissed=true", () => {
    sessionStorage.setItem("sc_cycle_ending_alert_dismissed", "1");
    useMembersMock.mockReturnValue({
      data: [mkMember({ id: "1", name: "A" })],
      isLoading: false,
    });

    const { result } = renderHook(() => useCyclesEndingAlert());

    expect(result.current.isDismissed).toBe(true);
  });

  it("dismiss() flips isDismissed AND writes the sessionStorage flag", () => {
    useMembersMock.mockReturnValue({
      data: [mkMember({ id: "1", name: "A" })],
      isLoading: false,
    });

    const { result } = renderHook(() => useCyclesEndingAlert());

    expect(result.current.isDismissed).toBe(false);
    expect(sessionStorage.getItem("sc_cycle_ending_alert_dismissed")).toBeNull();

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.isDismissed).toBe(true);
    expect(sessionStorage.getItem("sc_cycle_ending_alert_dismissed")).toBe("1");
  });

  it("useMembers loading → isLoading=true with empty count + members", () => {
    useMembersMock.mockReturnValue({ data: undefined, isLoading: true });

    const { result } = renderHook(() => useCyclesEndingAlert());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.count).toBe(0);
    expect(result.current.members).toEqual([]);
  });
});
