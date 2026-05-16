// Story 10.3 — useDisputes tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fromMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: { from: (...args: unknown[]) => fromMock(...args) },
}));

import { useDisputes } from "./useDisputes";

const MEMBER_ID = "m0000000-0000-4000-8000-000000000001";

/** A minimal thenable PostgREST-builder stub: every chained method
 *  returns the same object, which resolves to `result` when awaited. */
function builder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const OPEN_DISPUTE = {
  id: "d0000000-0000-4000-8000-000000000001",
  transaction_id: "a0000000-0000-4000-8000-000000000001",
  notes: "pas moi",
  flagged_at: "2026-05-10T09:30:00.000Z",
  status: "open",
  // The embedded join key — disputeRowSchema (non-strict) drops it.
  transactions: { member_id: MEMBER_ID },
};

describe("useDisputes", () => {
  beforeEach(() => fromMock.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("returns the member's open disputes, stripping the embedded join key", async () => {
    fromMock.mockReturnValue(builder({ data: [OPEN_DISPUTE], error: null }));
    const { result } = renderHook(() => useDisputes(MEMBER_ID), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]).toEqual({
      id: OPEN_DISPUTE.id,
      transaction_id: OPEN_DISPUTE.transaction_id,
      notes: "pas moi",
      flagged_at: OPEN_DISPUTE.flagged_at,
      status: "open",
    });
    expect(fromMock).toHaveBeenCalledWith("disputes");
  });

  it("returns an empty array when the member has no open disputes", async () => {
    fromMock.mockReturnValue(builder({ data: [], error: null }));
    const { result } = renderHook(() => useDisputes(MEMBER_ID), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("surfaces a query error", async () => {
    fromMock.mockReturnValue(builder({ data: null, error: { message: "RLS denied" } }));
    const { result } = renderHook(() => useDisputes(MEMBER_ID), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/disputes query failed/);
  });

  it("is disabled when memberId is undefined", () => {
    const { result } = renderHook(() => useDisputes(undefined), { wrapper: makeWrapper() });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fromMock).not.toHaveBeenCalled();
  });
});
