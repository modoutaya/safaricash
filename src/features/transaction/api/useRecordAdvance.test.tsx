// Story 5.4 — useRecordAdvance hook tests covering each error code.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { useRecordAdvance, RecordAdvanceError } from "./useRecordAdvance";

const INPUT = {
  memberId: "11111111-1111-4111-8111-111111111111",
  cycleId: "22222222-2222-4222-8222-222222222222",
  amount: 50_000,
  cycleDay: 10,
  motive: "urgence médicale",
  saverAcknowledged: true as const,
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useRecordAdvance", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — calls record_advance RPC with mapped args + returns new tx id", async () => {
    rpcMock.mockResolvedValue({ data: "33333333-3333-4333-8333-333333333333", error: null });
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });

    let returned: string | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(INPUT);
    });

    expect(rpcMock).toHaveBeenCalledWith("record_advance", {
      p_member_id: INPUT.memberId,
      p_cycle_id: INPUT.cycleId,
      p_amount: INPUT.amount,
      p_cycle_day: INPUT.cycleDay,
      p_motive: INPUT.motive,
      p_saver_acknowledged: true,
    });
    expect(returned).toBe("33333333-3333-4333-8333-333333333333");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("Zod rejects motive < 3 chars BEFORE the RPC fires (validation)", async () => {
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.mutateAsync({ ...INPUT, motive: "ok" })).rejects.toBeInstanceOf(
        RecordAdvanceError,
      );
    });
    expect(rpcMock).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.error?.code).toBe("validation"));
  });

  it("classifies sqlstate 23514 → cycle_closed", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "23514", message: "cycle_closed: cannot record advance on a completed cycle" },
    });
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordAdvanceError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("cycle_closed"));
  });

  it("classifies sqlstate 22023 → over_limit", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "over_limit: advance exceeds projected available balance" },
    });
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordAdvanceError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("over_limit"));
  });

  it("classifies invalid_motive RPC error → invalid_motive", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "22000", message: "invalid_motive: motive must be at least 3 characters" },
    });
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordAdvanceError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("invalid_motive"));
  });

  it("classifies missing_acknowledgment RPC error → missing_acknowledgment", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "22000", message: "missing_acknowledgment: saver acknowledgment required" },
    });
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordAdvanceError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("missing_acknowledgment"));
  });

  it("classifies auth_required → unauthorized", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "28000", message: "auth_required: caller is not authenticated" },
    });
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordAdvanceError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unauthorized"));
  });

  it("classifies P0002 → not_found", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "not_found: member does not exist" },
    });
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordAdvanceError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("falls back to unknown for unrecognised errors", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "boom from outer space" },
    });
    const { result } = renderHook(() => useRecordAdvance(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(RecordAdvanceError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });
});
