// Story 2.6 — useDeleteMember tests covering each DeleteMemberErrorCode.

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

import { useDeleteMember, DeleteMemberError } from "./useDeleteMember";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useDeleteMember", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — calls delete_member with the right args + resolves", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useDeleteMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.mutateAsync(MEMBER_ID);
    });

    expect(rpcMock).toHaveBeenCalledWith("delete_member", { p_id: MEMBER_ID });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("classifies auth_required as 'unauthorized'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "auth_required: caller …" } });
    const { result } = renderHook(() => useDeleteMember(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(DeleteMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unauthorized"));
  });

  it("classifies P0002 as 'not_found'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found: gone" } });
    const { result } = renderHook(() => useDeleteMember(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(DeleteMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("classifies fetch failures as 'network'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    const { result } = renderHook(() => useDeleteMember(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(DeleteMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("network"));
  });

  it("falls back to 'unknown' for unrecognised errors", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom from outer space" } });
    const { result } = renderHook(() => useDeleteMember(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(DeleteMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });
});
