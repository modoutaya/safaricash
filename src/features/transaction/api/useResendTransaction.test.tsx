// Story 6.7 — useResendTransaction hook tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { MEMBER_PROFILE_QUERY_KEY } from "@/features/member";

import { ResendTransactionError } from "./resendTransactionError";
import { useResendTransaction } from "./useResendTransaction";

const TX_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

function makeWrapper(client?: QueryClient): {
  client: QueryClient;
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
} {
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { client: queryClient, Wrapper };
}

describe("useResendTransaction", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    invalidateMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — returns { enqueued: 1, reason: null } and invalidates member profile", async () => {
    rpcMock.mockResolvedValue({ data: [{ enqueued: 1, reason: null }], error: null });
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResendTransaction(), { wrapper: Wrapper });

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync({ transactionId: TX_ID, memberId: MEMBER_ID });
    });

    expect(rpcMock).toHaveBeenCalledWith("enqueue_resend_transaction", {
      p_transaction_id: TX_ID,
    });
    expect(resolved).toEqual({ enqueued: 1, reason: null });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, MEMBER_ID] }),
    );
  });

  it("opt_out reason — returns 0/opt_out, does NOT invalidate", async () => {
    rpcMock.mockResolvedValue({ data: [{ enqueued: 0, reason: "opt_out" }], error: null });
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResendTransaction(), { wrapper: Wrapper });

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync({ transactionId: TX_ID, memberId: MEMBER_ID });
    });
    expect(resolved).toEqual({ enqueued: 0, reason: "opt_out" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("no_phone / undone / unsupported_kind reasons round-trip", async () => {
    for (const reason of ["no_phone", "undone", "unsupported_kind"] as const) {
      rpcMock.mockResolvedValue({ data: [{ enqueued: 0, reason }], error: null });
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useResendTransaction(), { wrapper: Wrapper });
      let resolved: { reason: string } | undefined;
      await act(async () => {
        resolved = (await result.current.mutateAsync({ transactionId: TX_ID })) as {
          reason: string;
        };
      });
      expect(resolved?.reason).toBe(reason);
    }
  });

  it("P0002 → ResendTransactionError code='not_found'", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "transaction_not_found" },
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useResendTransaction(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ transactionId: TX_ID })).rejects.toBeInstanceOf(
        ResendTransactionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("28000 → ResendTransactionError code='auth_unauthenticated'", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "28000", message: "auth_required" },
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useResendTransaction(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ transactionId: TX_ID })).rejects.toBeInstanceOf(
        ResendTransactionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("auth_unauthenticated"));
  });

  it("other PG error → ResendTransactionError code='internal_unexpected'", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useResendTransaction(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ transactionId: TX_ID })).rejects.toBeInstanceOf(
        ResendTransactionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("internal_unexpected"));
  });

  it("thrown TypeError → ResendTransactionError code='network'", async () => {
    rpcMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useResendTransaction(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ transactionId: TX_ID })).rejects.toBeInstanceOf(
        ResendTransactionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("network"));
  });
});
