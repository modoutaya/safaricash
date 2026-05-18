// Story 8.4 — useReconciler hook tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replayMock = vi.fn();
const useCollectorIdMock = vi.fn();
const computeBackoffMock = vi.fn().mockReturnValue(10_000);

vi.mock("@/infrastructure/sync", () => ({
  replayPendingEvents: (collectorId: string) => replayMock(collectorId),
  computeBackoffMs: (attempt: number) => computeBackoffMock(attempt),
}));

vi.mock("@/features/auth/api/useCollectorId", () => ({
  useCollectorId: () => useCollectorIdMock(),
}));

import { useReconciler } from "./useReconciler";

const COLLECTOR = "11111111-1111-4111-8111-111111111111";

function wrap() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, invalidateSpy, wrapper: Wrapper };
}

beforeEach(() => {
  replayMock.mockReset();
  replayMock.mockResolvedValue({
    attempted: 0,
    succeeded: 0,
    skipped: 0,
    networkFailures: 0,
    sessionFailures: 0,
    durationMs: 0,
  });
  useCollectorIdMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useReconciler", () => {
  it("triggers replayPendingEvents on mount when collectorId is present", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    const { wrapper } = wrap();
    renderHook(() => useReconciler(), { wrapper });
    await waitFor(() => expect(replayMock).toHaveBeenCalledWith(COLLECTOR));
  });

  it("does NOT trigger when collectorId is null (session not yet resolved)", async () => {
    useCollectorIdMock.mockReturnValue(null);
    const { wrapper } = wrap();
    renderHook(() => useReconciler(), { wrapper });
    // Let any microtask flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(replayMock).not.toHaveBeenCalled();
  });

  it("re-triggers on window `online` event", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    const { wrapper } = wrap();
    renderHook(() => useReconciler(), { wrapper });
    await waitFor(() => expect(replayMock).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(replayMock).toHaveBeenCalledTimes(2));
  });

  it("invalidates MEMBERS + MEMBER_PROFILE + DASHBOARD queries on successful drain (succeeded > 0 && networkFailures == 0)", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    replayMock.mockResolvedValue({
      attempted: 3,
      succeeded: 3,
      skipped: 0,
      networkFailures: 0,
      sessionFailures: 0,
      durationMs: 1234,
    });
    const { invalidateSpy, wrapper } = wrap();
    renderHook(() => useReconciler(), { wrapper });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(3));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["members", "list"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard", "transactions"] });
  });

  it("does NOT invalidate when the drain had network failures", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    replayMock.mockResolvedValue({
      attempted: 2,
      succeeded: 1,
      skipped: 0,
      networkFailures: 1,
      sessionFailures: 0,
      durationMs: 500,
    });
    const { invalidateSpy, wrapper } = wrap();
    renderHook(() => useReconciler(), { wrapper });

    await waitFor(() => expect(replayMock).toHaveBeenCalled());
    // Wait briefly for any post-replay microtask to flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("removes the `online` listener on unmount", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    const { wrapper } = wrap();
    const { unmount } = renderHook(() => useReconciler(), { wrapper });
    await waitFor(() => expect(replayMock).toHaveBeenCalledTimes(1));

    unmount();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    // No new call after unmount.
    expect(replayMock).toHaveBeenCalledTimes(1);
  });
});
