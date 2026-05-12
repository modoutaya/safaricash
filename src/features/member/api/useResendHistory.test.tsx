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

  // Coverage-driven additions — exercise the remaining classifyError branches
  // so the file's branch coverage reaches the global 75% gate.

  it("400 request_invalid → code='request_invalid'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Bad request",
        context: makeProblemResponse(400, "request_invalid"),
      },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("request_invalid"));
  });

  it("500 internal_unexpected → code='internal_unexpected'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Server exploded",
        context: makeProblemResponse(500, "internal_unexpected"),
      },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("internal_unexpected"));
  });

  it("401 with non-credentials problemType → still maps to credentials_invalid (auth_unauthenticated fallback)", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "JWT expired",
        context: makeProblemResponse(401, "auth_unauthenticated"),
      },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    // Spec line 84: 401 defaults to credentials_invalid since the dialog
    // already authenticated via JWT; a 401 here is almost always a wrong
    // password. The auth_unauthenticated branch is taken via the problemType
    // match but the returned code is credentials_invalid.
    await waitFor(() => expect(result.current.error?.code).toBe("credentials_invalid"));
  });

  it("unrecognized error (no problemType, no status, not TypeError) → code='unknown'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: "something else entirely" },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });

  it("malformed success response (data with non-numeric enqueued) → throws", async () => {
    invokeMock.mockResolvedValue({
      data: { enqueued: "three", reason: null }, // intentionally wrong shape
      error: null,
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });

  it("error.context is a plain object with status (not a Response)", async () => {
    // Defensive: supabase-js historical variance. The hook reads status
    // from the plain-object branch when ctx.json is not a function.
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: "x", context: { status: 429 } },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("rate_limited"));
  });

  it("error.context Response body is non-JSON — falls through to status-based mapping", async () => {
    const ctx = new Response("not json at all", { status: 404 });
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: "?", context: ctx },
    });
    const { result } = renderHook(() => useResendHistory(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(ResendHistoryError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });
});
