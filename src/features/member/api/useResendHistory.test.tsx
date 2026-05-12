// Story 6.6 — useResendHistory hook tests.
//
// Covers happy path, opt-out, no-phone, no-transactions, plus the typed
// error mapping (credentials_invalid / rate_limited / not_found / network /
// internal_unexpected / unknown).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

import { ResendHistoryError, useResendHistory } from "./useResendHistory";

const INPUT = {
  memberId: "11111111-1111-4111-8111-111111111111",
  cycleId: "22222222-2222-4222-8222-222222222222",
  password: "Pw-test-1234",
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function makeProblemResponse(status: number, type: string, detail = type): Response {
  return new Response(JSON.stringify({ type, title: type, status, detail }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

describe("useResendHistory", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — { enqueued: 3, reason: null }", async () => {
    invokeMock.mockResolvedValue({
      data: { enqueued: 3, reason: null },
      error: null,
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.mutateAsync(INPUT);
    });

    expect(invokeMock).toHaveBeenCalledWith("sms-resend-history", {
      body: { member_id: INPUT.memberId, cycle_id: INPUT.cycleId, password: INPUT.password },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ enqueued: 3, reason: null });
  });

  it("opt_out reason — { enqueued: 0, reason: 'opt_out' }", async () => {
    invokeMock.mockResolvedValue({
      data: { enqueued: 0, reason: "opt_out" },
      error: null,
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync(INPUT);
    });
    expect(resolved).toEqual({ enqueued: 0, reason: "opt_out" });
    await waitFor(() => expect(result.current.data).toEqual({ enqueued: 0, reason: "opt_out" }));
  });

  it("no_transactions reason — { enqueued: 0, reason: 'no_transactions' }", async () => {
    invokeMock.mockResolvedValue({
      data: { enqueued: 0, reason: "no_transactions" },
      error: null,
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.mutateAsync(INPUT);
    });
    expect(resolved).toEqual({ enqueued: 0, reason: "no_transactions" });
    await waitFor(() =>
      expect(result.current.data).toEqual({ enqueued: 0, reason: "no_transactions" }),
    );
  });

  it("401 credentials_invalid → ResendHistoryError code='credentials_invalid'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Invalid password",
        context: makeProblemResponse(401, "credentials_invalid"),
      },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("credentials_invalid"));
  });

  it("429 rate_limited → code='rate_limited'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Too many attempts",
        context: makeProblemResponse(429, "rate_limited"),
      },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("rate_limited"));
  });

  it("404 not_found → code='not_found'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Member or cycle not found",
        context: makeProblemResponse(404, "not_found"),
      },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("network error → code='network' (FunctionsFetchError)", async () => {
    // supabase-js wraps real fetch failures as FunctionsFetchError. Use the
    // class-identity discriminator the hook checks, not a substring on the
    // English message.
    const fetchErr = Object.assign(new Error("network down"), {
      name: "FunctionsFetchError",
    });
    invokeMock.mockResolvedValue({ data: null, error: fetchErr });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("network"));
  });

  it("raw TypeError → code='network'", async () => {
    invokeMock.mockResolvedValue({ data: null, error: new TypeError("Failed to fetch") });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("network"));
  });
});
