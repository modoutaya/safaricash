// Story 4.6 follow-up — useCollectorName hook tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useCollectorIdMock = vi.fn();
const maybeSingleMock = vi.fn();

vi.mock("@/features/auth/api/useCollectorId", () => ({
  useCollectorId: () => useCollectorIdMock(),
}));

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => maybeSingleMock(),
        }),
      }),
    }),
  },
}));

import { useCollectorName } from "./useCollectorName";

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useCollectorName", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null while no collector id is resolved", () => {
    useCollectorIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useCollectorName(), { wrapper: makeWrapper() });
    expect(result.current).toBeNull();
    expect(maybeSingleMock).not.toHaveBeenCalled();
  });

  it("returns the collector's name from public.users", async () => {
    useCollectorIdMock.mockReturnValue("c1");
    maybeSingleMock.mockResolvedValue({ data: { name: "Awa Diallo" }, error: null });
    const { result } = renderHook(() => useCollectorName(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current).toBe("Awa Diallo"));
  });

  it("returns null when the collector has no name set", async () => {
    useCollectorIdMock.mockReturnValue("c1");
    maybeSingleMock.mockResolvedValue({ data: { name: null }, error: null });
    const { result } = renderHook(() => useCollectorName(), { wrapper: makeWrapper() });
    await waitFor(() => expect(maybeSingleMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("returns null on a query error", async () => {
    useCollectorIdMock.mockReturnValue("c1");
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { result } = renderHook(() => useCollectorName(), { wrapper: makeWrapper() });
    await waitFor(() => expect(maybeSingleMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
