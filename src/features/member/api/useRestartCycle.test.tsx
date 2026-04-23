// Story 2.7 — useRestartCycle tests covering each RestartCycleErrorCode.

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

import { useRestartCycle, RestartCycleError } from "./useRestartCycle";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const NEW_CYCLE_ID = "99999999-9999-4999-8999-999999999999";

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useRestartCycle", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — calls restart_member_cycle with the right args + returns the new cycle id", async () => {
    rpcMock.mockResolvedValue({ data: NEW_CYCLE_ID, error: null });
    const { result } = renderHook(() => useRestartCycle(), { wrapper: makeWrapper() });

    let returned: string | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(MEMBER_ID);
    });

    expect(rpcMock).toHaveBeenCalledWith("restart_member_cycle", { p_member_id: MEMBER_ID });
    expect(returned).toBe(NEW_CYCLE_ID);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("classifies auth_required as 'unauthorized'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "auth_required: caller …" } });
    const { result } = renderHook(() => useRestartCycle(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(RestartCycleError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unauthorized"));
  });

  it("classifies 22000 / not_restartable as 'not_restartable'", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "22000", message: "not_restartable: latest cycle status is active" },
    });
    const { result } = renderHook(() => useRestartCycle(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(RestartCycleError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_restartable"));
  });

  it("classifies P0002 as 'not_found'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found: gone" } });
    const { result } = renderHook(() => useRestartCycle(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(RestartCycleError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("classifies fetch failures as 'network'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    const { result } = renderHook(() => useRestartCycle(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(RestartCycleError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("network"));
  });

  it("falls back to 'unknown' for unrecognised errors", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom from outer space" } });
    const { result } = renderHook(() => useRestartCycle(), { wrapper: makeWrapper() });
    await act(async () => {
      await expect(result.current.mutateAsync(MEMBER_ID)).rejects.toBeInstanceOf(RestartCycleError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });
});
