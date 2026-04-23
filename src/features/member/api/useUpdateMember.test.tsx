// Story 2.5 — useUpdateMember tests. RTL renderHook + a stub supabase.rpc
// covering the full UpdateMemberErrorCode surface.

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

import { useUpdateMember, UpdateMemberError } from "./useUpdateMember";
import type { UpdateMemberInput } from "../types";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

const VALUES: UpdateMemberInput = {
  name: "Awa N.",
  phoneNumber: "+221770000001",
  dailyAmount: 1000,
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useUpdateMember", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — calls update_member RPC with the right args + resolves", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.mutateAsync({ id: VALID_ID, values: VALUES });
    });

    expect(rpcMock).toHaveBeenCalledWith("update_member", {
      p_id: VALID_ID,
      p_name: "Awa N.",
      p_phone_number: "+221770000001",
      p_daily_amount: 1000,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("classifies auth_required as 'unauthorized'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "auth_required: caller …" } });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unauthorized"));
  });

  it("classifies 23505 as 'duplicate_phone'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "23505", message: "dup" } });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("duplicate_phone"));
  });

  it("classifies invalid_amount as 'validation'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "invalid_amount: too big" } });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("validation"));
  });

  it("classifies P0002 as 'not_found'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found: gone" } });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("classifies fetch failures as 'network'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("network"));
  });

  it("falls back to 'unknown' for unrecognised errors", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom from outer space" } });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });
});
