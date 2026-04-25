// Story 4.3 — useRecordContribution tests covering each error code.
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

import { useRecordContribution, RecordContributionError } from "./useRecordContribution";

const INPUT = {
  memberId: "11111111-1111-4111-8111-111111111111",
  cycleId: "22222222-2222-4222-8222-222222222222",
  amount: 500,
  cycleDay: 5,
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useRecordContribution", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — calls record_contribution RPC + returns the new tx id", async () => {
    rpcMock.mockResolvedValue({ data: "33333333-3333-4333-8333-333333333333", error: null });
    const { result } = renderHook(() => useRecordContribution(), { wrapper: makeWrapper() });

    let returned: string | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(INPUT);
    });

    expect(rpcMock).toHaveBeenCalledWith("record_contribution", {
      p_member_id: INPUT.memberId,
      p_cycle_id: INPUT.cycleId,
      p_amount: INPUT.amount,
      p_cycle_day: INPUT.cycleDay,
    });
    expect(returned).toBe("33333333-3333-4333-8333-333333333333");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("classifies sqlstate 23514 as 'cycle_closed' (Story 3.4 trigger)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "23514", message: "cycle_closed: …" } });
    const { result } = renderHook(() => useRecordContribution(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("cycle_closed"));
  });

  it("classifies auth_required as 'unauthorized'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "auth_required: …" } });
    const { result } = renderHook(() => useRecordContribution(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unauthorized"));
  });

  it("classifies invalid_amount as 'validation'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "invalid_amount: …" } });
    const { result } = renderHook(() => useRecordContribution(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("validation"));
  });

  it("classifies P0002 as 'not_found'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found: …" } });
    const { result } = renderHook(() => useRecordContribution(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("falls back to 'unknown' for unrecognised errors", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom from outer space" } });
    const { result } = renderHook(() => useRecordContribution(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });
});
