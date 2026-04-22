// Story 2.3 — useImportMembers tests.
//
// Cover: happy path (all rows ok, query invalidated N times), partial
// failure (mixed states + retryFailed re-fires only failed rows), and
// the 5-concurrency cap.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
  },
}));

import { useImportMembers, type ImportRow } from "./useImportMembers";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { QueryWrapper, client };
}

const ROW = (i: number): ImportRow => ({
  name: `Member ${i}`,
  phoneNumber: "",
  dailyAmount: 500,
});

describe("useImportMembers", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("happy path — all rows ok + invalidates MEMBERS_QUERY_KEY per success", async () => {
    let counter = 0;
    rpcMock.mockImplementation(() => {
      counter += 1;
      return Promise.resolve({ data: `member-${counter}`, error: null });
    });
    const { QueryWrapper, client } = wrapper();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useImportMembers(), { wrapper: QueryWrapper });
    const rows = [ROW(0), ROW(1), ROW(2)];
    await act(() => result.current.start(rows));

    await waitFor(() => expect(result.current.summary.ok).toBe(3));
    expect(result.current.summary.failed).toBe(0);
    expect(rpcMock).toHaveBeenCalledTimes(3);
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
  });

  it("partial failure — 1 of 3 fails, retryFailed re-fires only the failed row", async () => {
    rpcMock.mockImplementation((_fn, args: { p_name: string }) => {
      if (args.p_name === "Member 1") {
        return Promise.resolve({
          data: null,
          error: { message: "23505 duplicate", code: "23505" },
        });
      }
      return Promise.resolve({ data: `member-${args.p_name}`, error: null });
    });
    const { QueryWrapper } = wrapper();
    const { result } = renderHook(() => useImportMembers(), { wrapper: QueryWrapper });

    const rows = [ROW(0), ROW(1), ROW(2)];
    await act(() => result.current.start(rows));
    await waitFor(() => expect(result.current.isRunning).toBe(false));

    expect(result.current.summary.ok).toBe(2);
    expect(result.current.summary.failed).toBe(1);
    const row1 = result.current.results.get(1);
    expect(row1?.status).toBe("error");
    if (row1?.status === "error") expect(row1.code).toBe("duplicate_phone");

    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: "member-retry", error: null });
    await act(() => result.current.retryFailed());
    await waitFor(() => expect(result.current.summary.failed).toBe(0));

    // Only the failed row was re-fired (not the 2 that already succeeded).
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "create_member_with_cycle",
      expect.objectContaining({ p_name: "Member 1" }),
    );
    expect(result.current.summary.ok).toBe(3);
  });

  it("respects the 5-slot concurrency cap on a 12-row batch", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    rpcMock.mockImplementation(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        // resolve on next macrotask so inFlight stays elevated long enough
        // for the limiter to reach its ceiling.
        setTimeout(() => {
          inFlight -= 1;
          resolve({ data: `member-${maxInFlight}`, error: null });
        }, 0);
      });
    });
    const { QueryWrapper } = wrapper();
    const { result } = renderHook(() => useImportMembers(), { wrapper: QueryWrapper });

    const rows = Array.from({ length: 12 }, (_, i) => ROW(i));
    await act(() => result.current.start(rows));
    await waitFor(() => expect(result.current.summary.ok).toBe(12));

    expect(maxInFlight).toBeLessThanOrEqual(5);
    // Sanity — at least 2 in flight at peak (otherwise we're sequential, not parallel).
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it("classifies network errors", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch" },
    });
    const { QueryWrapper } = wrapper();
    const { result } = renderHook(() => useImportMembers(), { wrapper: QueryWrapper });

    await act(() => result.current.start([ROW(0)]));
    await waitFor(() => expect(result.current.summary.failed).toBe(1));
    const r = result.current.results.get(0);
    if (r?.status === "error") expect(r.code).toBe("network");
  });
});
