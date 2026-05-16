// Story 10.3 — useResolveDispute tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fromMock = vi.fn();
const updateMock = vi.fn();
const eqMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: { from: (...args: unknown[]) => fromMock(...args) },
}));

import { useResolveDispute } from "./useResolveDispute";
import { DISPUTES_QUERY_KEY } from "../types";

const MEMBER_ID = "a0000000-0000-4000-8000-000000000001";
const DISPUTE_ID = "d0000000-0000-4000-8000-000000000001";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useResolveDispute", () => {
  beforeEach(() => {
    fromMock.mockReset();
    updateMock.mockReset();
    eqMock.mockReset();
    selectMock.mockReset();
    // supabase.from("disputes").update({...}).eq("id", id)
    //   .eq("status", "open").select("id") → { data, error }
    fromMock.mockReturnValue({ update: updateMock });
    updateMock.mockReturnValue({ eq: eqMock });
    eqMock.mockReturnValue({ eq: eqMock, select: selectMock });
  });
  afterEach(() => vi.clearAllMocks());

  it("updates the dispute to resolved + invalidates the disputes query", async () => {
    selectMock.mockResolvedValue({ data: [{ id: DISPUTE_ID }], error: null });
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResolveDispute(MEMBER_ID), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync(DISPUTE_ID);
    });

    expect(fromMock).toHaveBeenCalledWith("disputes");
    const updateArg = updateMock.mock.calls[0]![0] as { status: string; resolved_at: string };
    expect(updateArg.status).toBe("resolved");
    expect(Number.isNaN(Date.parse(updateArg.resolved_at))).toBe(false);
    expect(eqMock).toHaveBeenCalledWith("id", DISPUTE_ID);
    expect(eqMock).toHaveBeenCalledWith("status", "open");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: [...DISPUTES_QUERY_KEY, "member", MEMBER_ID],
    });
  });

  it("rejects + surfaces the error when the update fails", async () => {
    selectMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { result } = renderHook(() => useResolveDispute(MEMBER_ID), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(async () => {
      await expect(result.current.mutateAsync(DISPUTE_ID)).rejects.toThrow(
        /resolve dispute failed/,
      );
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("rejects when the dispute is no longer open (zero rows updated)", async () => {
    selectMock.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useResolveDispute(MEMBER_ID), {
      wrapper: wrapperFor(makeClient()),
    });
    await act(async () => {
      await expect(result.current.mutateAsync(DISPUTE_ID)).rejects.toThrow(/not open/);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
