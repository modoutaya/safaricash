// Story 4.4 — useRecordRattrapage tests covering each error code.
// Story 8.3 — offline-fallback + optimistic UI tests.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: { getSession: () => getSessionMock() },
  },
}));

const appendEventMock = vi.fn();
vi.mock("@/infrastructure/sync", () => ({
  appendEvent: (event: unknown) => appendEventMock(event),
}));

import { useRecordRattrapage, RecordRattrapageError } from "./useRecordRattrapage";

const INPUT = {
  memberId: "11111111-1111-4111-8111-111111111111",
  cycleId: "22222222-2222-4222-8222-222222222222",
  dailyAmount: 500,
  cycleDay: 10,
  daysCovered: 3,
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const COLLECTOR_ID = "44444444-4444-4444-8444-444444444444";

describe("useRecordRattrapage", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    appendEventMock.mockReset();
    appendEventMock.mockResolvedValue(undefined);
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: COLLECTOR_ID } } } });
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — calls record_rattrapage RPC with the daysCovered arg + returns new tx id", async () => {
    rpcMock.mockResolvedValue({ data: "33333333-3333-4333-8333-333333333333", error: null });
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    let returned: { txId: string; wasOffline: boolean } | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(INPUT);
    });

    expect(rpcMock).toHaveBeenCalledWith("record_rattrapage", {
      p_member_id: INPUT.memberId,
      p_cycle_id: INPUT.cycleId,
      p_daily_amount: INPUT.dailyAmount,
      p_cycle_day: INPUT.cycleDay,
      p_days_covered: INPUT.daysCovered,
    });
    expect(returned).toEqual({
      txId: "33333333-3333-4333-8333-333333333333",
      wasOffline: false,
    });
    expect(appendEventMock).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("Story 8.3 — navigator.onLine === false skips RPC + appends to event log", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    let returned: { txId: string; wasOffline: boolean } | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(INPUT);
    });

    expect(rpcMock).not.toHaveBeenCalled();
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(appendEventMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: "transaction.rattrapage_recorded",
      collectorId: COLLECTOR_ID,
    });
    expect(returned?.wasOffline).toBe(true);
  });

  it("Story 8.3 — TypeError fetch failure falls back to offline branch", async () => {
    rpcMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    let returned: { txId: string; wasOffline: boolean } | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(INPUT);
    });

    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(returned?.wasOffline).toBe(true);
  });

  it("classifies sqlstate 23514 with cycle context → cycle_closed (and does NOT append)", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        code: "23514",
        message: "cycle_closed: cannot record rattrapage on a completed cycle",
      },
    });
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordRattrapageError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("cycle_closed"));
    // Story 8.3 patch — non-network errors must NOT fall back to the offline log.
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it("classifies sqlstate 23514 with days_covered context → invalid_days", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        code: "23514",
        message:
          'new row for relation "transactions" violates check constraint "transactions_days_covered_kind_chk"',
      },
    });
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordRattrapageError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("invalid_days"));
  });

  it("classifies invalid_days_covered RPC error → invalid_days", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "22000", message: "invalid_days_covered: days_covered must be in [2, 4]" },
    });
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordRattrapageError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("invalid_days"));
  });

  it("classifies invalid_amount → validation", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "22000", message: "invalid_amount: daily_amount must be positive" },
    });
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordRattrapageError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("validation"));
  });

  it("classifies auth_required → unauthorized", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "28000", message: "auth_required: caller is not authenticated" },
    });
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordRattrapageError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unauthorized"));
  });

  it("classifies P0002 → not_found", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "not_found: member does not exist" },
    });
    const { result } = renderHook(() => useRecordRattrapage(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordRattrapageError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });
});
