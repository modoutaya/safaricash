// Story 7.4 — useCommitSettlement hook tests.
//
// Covers happy path, all classifyError branches (payout_mismatch /
// cycle_not_settleable / credentials_invalid / rate_limited / not_found /
// request_invalid / internal_unexpected / network / unknown), malformed
// response, plain-object context fallback, non-JSON Response body, and the
// query invalidation side-effect.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

import { CommitSettlementError } from "./commitSettlementError";
import { useCommitSettlement } from "./useCommitSettlement";

const INPUT = {
  memberId: "11111111-1111-4111-8111-111111111111",
  cycleId: "22222222-2222-4222-8222-222222222222",
  expectedPayout: 11_500,
  password: "Pw-test-1234",
};

const HAPPY_DATA = {
  ok: true as const,
  settlement_transaction_id: "33333333-3333-4333-8333-333333333333",
  settled_payout: 11_500,
  settled_at: "2026-05-14T12:34:56Z",
};

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Patch invalidateQueries so we can assert it was called.
  client.invalidateQueries = ((arg: unknown) => {
    invalidateMock(arg);
    return Promise.resolve();
  }) as typeof client.invalidateQueries;
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function makeProblemResponse(
  status: number,
  type: string,
  detail = type,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ type, title: type, status, detail, ...extra }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

describe("useCommitSettlement", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invalidateMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — invokes cycle-settlement with body + returns result", async () => {
    invokeMock.mockResolvedValue({ data: HAPPY_DATA, error: null });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.mutateAsync(INPUT);
    });
    expect(invokeMock).toHaveBeenCalledWith("cycle-settlement", {
      body: {
        member_id: INPUT.memberId,
        cycle_id: INPUT.cycleId,
        expected_payout: INPUT.expectedPayout,
        password: INPUT.password,
      },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(HAPPY_DATA);
  });

  it("onSuccess invalidates the member-profile query", async () => {
    invokeMock.mockResolvedValue({ data: HAPPY_DATA, error: null });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.mutateAsync(INPUT);
    });
    await waitFor(() => expect(invalidateMock).toHaveBeenCalled());
    const callArg = invalidateMock.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({ queryKey: expect.arrayContaining([INPUT.memberId]) });
  });

  it("409 payout_mismatch → code='payout_mismatch'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Payout mismatch",
        context: makeProblemResponse(409, "payout_mismatch"),
      },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("payout_mismatch"));
  });

  it("409 cycle_not_settleable → code='cycle_not_settleable'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Cycle not settleable",
        context: makeProblemResponse(409, "cycle_not_settleable"),
      },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("cycle_not_settleable"));
  });

  it("401 credentials_invalid → code='credentials_invalid'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Invalid password",
        context: makeProblemResponse(401, "credentials_invalid"),
      },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
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
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("rate_limited"));
  });

  it("404 not_found → code='not_found'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Not found",
        context: makeProblemResponse(404, "not_found"),
      },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("400 request_invalid → code='request_invalid'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Bad request",
        context: makeProblemResponse(400, "request_invalid"),
      },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("request_invalid"));
  });

  it("500 internal_unexpected → code='internal_unexpected'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Server error",
        context: makeProblemResponse(500, "internal_unexpected"),
      },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("internal_unexpected"));
  });

  it("401 auth_unauthenticated → code='credentials_invalid' (defensive fallback)", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "JWT expired",
        context: makeProblemResponse(401, "auth_unauthenticated"),
      },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    // Defensive — 401 on a JWT-authenticated path is almost always wrong password.
    await waitFor(() => expect(result.current.error?.code).toBe("credentials_invalid"));
  });

  it("network error → code='network' (FunctionsFetchError)", async () => {
    const fetchErr = Object.assign(new Error("network down"), {
      name: "FunctionsFetchError",
    });
    invokeMock.mockResolvedValue({ data: null, error: fetchErr });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("network"));
  });

  it("raw TypeError → code='network'", async () => {
    invokeMock.mockResolvedValue({ data: null, error: new TypeError("Failed to fetch") });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("network"));
  });

  it("unrecognized error → code='unknown'", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: "something else entirely" },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });

  it("malformed success response (data.ok!==true) → throws unknown", async () => {
    invokeMock.mockResolvedValue({
      data: { ok: false, settled_payout: "wat" },
      error: null,
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });

  it("error.context plain-object with status=429 (not a Response) → rate_limited", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: "x", context: { status: 429 } },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("rate_limited"));
  });

  it("error.context Response body is non-JSON, status=409 → falls back to cycle_not_settleable (more recoverable)", async () => {
    const ctx = new Response("not json at all", { status: 409 });
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: "?", context: ctx },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("cycle_not_settleable"));
  });

  it("409 payout_mismatch with server_payout in body → CommitSettlementError.serverPayout populated", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: "Payout mismatch",
        context: makeProblemResponse(409, "payout_mismatch", "Payout mismatch", {
          server_payout: 12500,
        }),
      },
    });
    const { result } = renderHook(() => useCommitSettlement(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(CommitSettlementError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("payout_mismatch"));
    expect((result.current.error as CommitSettlementError | null)?.serverPayout).toBe(12500);
  });
});
