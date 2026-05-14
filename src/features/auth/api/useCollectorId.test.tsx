// Story 8.3 — useCollectorId hook tests.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Supabase auth mock — captures the onAuthStateChange callback so tests can
// fire SIGNED_IN / SIGNED_OUT / INITIAL_SESSION at controlled times.
// ---------------------------------------------------------------------------

type AuthListener = (event: string, session: { user: { id: string } } | null) => void;
let listener: AuthListener | null = null;
const unsubscribeSpy = vi.fn();
const getSessionMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => getSessionMock(),
      onAuthStateChange: (cb: AuthListener) => {
        listener = cb;
        return { data: { subscription: { unsubscribe: unsubscribeSpy } } };
      },
    },
  },
}));

import { useCollectorId } from "./useCollectorId";

beforeEach(() => {
  listener = null;
  unsubscribeSpy.mockReset();
  getSessionMock.mockReset();
  // Default: no persisted session.
  getSessionMock.mockResolvedValue({ data: { session: null } });
});

afterEach(() => {
  listener = null;
});

describe("useCollectorId", () => {
  it("returns null on initial render (getSession probe is async)", () => {
    const { result } = renderHook(() => useCollectorId());
    expect(result.current).toBeNull();
  });

  it("resolves to session.user.id after getSession() succeeds", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { user: { id: "11111111-1111-4111-8111-111111111111" } } },
    });

    const { result } = renderHook(() => useCollectorId());

    // Flush microtasks for the getSession Promise.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("updates on SIGNED_IN event", async () => {
    const { result } = renderHook(() => useCollectorId());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();

    act(() => {
      listener?.("SIGNED_IN", { user: { id: "22222222-2222-4222-8222-222222222222" } });
    });

    expect(result.current).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("updates on INITIAL_SESSION event when session is present", async () => {
    const { result } = renderHook(() => useCollectorId());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      listener?.("INITIAL_SESSION", { user: { id: "33333333-3333-4333-8333-333333333333" } });
    });

    expect(result.current).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("falls back to null on SIGNED_OUT", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { user: { id: "44444444-4444-4444-8444-444444444444" } } },
    });

    const { result } = renderHook(() => useCollectorId());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe("44444444-4444-4444-8444-444444444444");

    act(() => {
      listener?.("SIGNED_OUT", null);
    });

    expect(result.current).toBeNull();
  });

  it("unsubscribes from onAuthStateChange on unmount", async () => {
    const { unmount } = renderHook(() => useCollectorId());
    await act(async () => {
      await Promise.resolve();
    });
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });
});
