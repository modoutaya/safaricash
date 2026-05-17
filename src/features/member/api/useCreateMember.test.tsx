// Story 2.2 — useCreateMember unit tests.
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

import { useCreateMember } from "./useCreateMember";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return QueryWrapper;
}

const VALID_INPUT = {
  name: "Awa Diallo",
  phoneNumber: "+221777915898",
  dailyAmount: 500,
};

describe("useCreateMember", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("happy path: calls RPC with mapped args and returns member id", async () => {
    rpcMock.mockResolvedValue({ data: "member-uuid-123", error: null });
    const { result } = renderHook(() => useCreateMember(), { wrapper: wrapper() });

    const memberId = await act(() => result.current.mutateAsync(VALID_INPUT));

    expect(memberId).toBe("member-uuid-123");
    expect(rpcMock).toHaveBeenCalledWith("create_member_with_cycle", {
      p_name: "Awa Diallo",
      p_phone_number: "+221777915898",
      p_daily_amount: 500,
    });
  });

  it("rejects an empty phone — phone is required, RPC never called", async () => {
    const { result } = renderHook(() => useCreateMember(), { wrapper: wrapper() });

    await expect(
      result.current.mutateAsync({ ...VALID_INPUT, phoneNumber: "" }),
    ).rejects.toBeDefined();

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("maps auth_required RPC error to code 'unauthorized'", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "auth_required: caller is not authenticated", code: "28000" },
    });
    const { result } = renderHook(() => useCreateMember(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync(VALID_INPUT)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("maps insufficient_privilege (42501) to 'unauthorized'", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "permission denied for function", code: "42501" },
    });
    const { result } = renderHook(() => useCreateMember(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync(VALID_INPUT)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("maps invalid_amount server error to 'validation'", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "invalid_amount: daily_amount must be positive", code: "22000" },
    });
    const { result } = renderHook(() => useCreateMember(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync(VALID_INPUT)).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("maps network failure message to 'network'", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch", code: undefined },
    });
    const { result } = renderHook(() => useCreateMember(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync(VALID_INPUT)).rejects.toMatchObject({
      code: "network",
    });
  });

  it("falls back to 'unknown' on unclassified failures", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "something exploded" } });
    const { result } = renderHook(() => useCreateMember(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync(VALID_INPUT)).rejects.toMatchObject({
      code: "unknown",
    });
  });

  it("RPC returns non-string data → 'unknown'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useCreateMember(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync(VALID_INPUT)).rejects.toMatchObject({
      code: "unknown",
    });
  });

  it("invalidates the MEMBERS_QUERY_KEY on success", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    rpcMock.mockResolvedValue({ data: "member-uuid", error: null });

    const { result } = renderHook(() => useCreateMember(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await act(() => result.current.mutateAsync(VALID_INPUT));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["members", "list"],
      }),
    );
  });
});
