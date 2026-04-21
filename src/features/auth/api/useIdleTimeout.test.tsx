import { act, renderHook } from "@testing-library/react";
import type { AuthChangeEvent, Session, Subscription } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Supabase client mock — captures the onAuthStateChange callback so tests
// can emit synthetic SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED events.
// Matches the per-test `vi.mock` idiom from useLogin.test.tsx.
// ---------------------------------------------------------------------------

const signOutMock = vi.fn();
const getSessionMock = vi.fn();
const unsubscribeMock = vi.fn();

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;
let capturedAuthCallback: AuthCallback | null = null;

const onAuthStateChangeMock = vi.fn((cb: AuthCallback) => {
  capturedAuthCallback = cb;
  const subscription = { id: "mock", callback: cb, unsubscribe: unsubscribeMock };
  return { data: { subscription: subscription as unknown as Subscription } };
});

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    auth: {
      signOut: () => signOutMock(),
      getSession: () => getSessionMock(),
      onAuthStateChange: (cb: AuthCallback) => onAuthStateChangeMock(cb),
    },
  },
}));

import { SESSION_STARTED_AT_STORAGE_KEY } from "@/lib/constants";

import { useIdleTimeout } from "@/features/auth/api/useIdleTimeout";

// ---------------------------------------------------------------------------

const IDLE_MS = 60_000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60_000;

function buildConfig(overrides: Partial<Parameters<typeof useIdleTimeout>[0]> = {}) {
  return {
    idleMs: IDLE_MS,
    absoluteLifetimeMs: ABSOLUTE_MS,
    onExpired: vi.fn(),
    ...overrides,
  };
}

const fakeSession = { access_token: "jwt", user: { id: "u1" } } as unknown as Session;

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function emitAuth(event: AuthChangeEvent, session: Session | null): Promise<void> {
  if (!capturedAuthCallback) throw new Error("onAuthStateChange callback not captured");
  await act(async () => {
    capturedAuthCallback!(event, session);
  });
}

describe("useIdleTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signOutMock.mockReset();
    getSessionMock.mockReset();
    unsubscribeMock.mockReset();
    onAuthStateChangeMock.mockClear();
    capturedAuthCallback = null;
    window.localStorage.clear();
    // Default: no active session on initial probe.
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Idle expiry
  // -------------------------------------------------------------------------

  it("fires onExpired after idleMs with no activity when a session is present on mount", async () => {
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();

    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS);
    });

    expect(cfg.onExpired).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire on mount when no session exists", async () => {
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS * 10);
    });
    expect(cfg.onExpired).not.toHaveBeenCalled();
  });

  it.each([["mousedown"], ["keydown"], ["touchstart"], ["scroll"]])(
    "resets the idle timer on window %s",
    async (eventType) => {
      getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
      const cfg = buildConfig();
      renderHook(() => useIdleTimeout(cfg));
      await flushMicrotasks();

      // Dispatch at 10s past mount (well inside the idle window). The hook
      // cancels the pending timer immediately, debounces the re-arm, and the
      // new timer targets lastActivity + idleMs.
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      await act(async () => {
        window.dispatchEvent(new Event(eventType));
      });

      // 1 ms before the re-armed timer (which is at event + idleMs) — must
      // not have fired yet.
      await act(async () => {
        vi.advanceTimersByTime(IDLE_MS - 1);
      });
      expect(cfg.onExpired).not.toHaveBeenCalled();

      // 2 ms more crosses the target → exactly one firing.
      await act(async () => {
        vi.advanceTimersByTime(2);
      });
      expect(cfg.onExpired).toHaveBeenCalledTimes(1);
    },
  );

  it("does NOT reset on mousemove (anti-pattern guard — surface stays narrow)", async () => {
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS - 1_000);
    });
    await act(async () => {
      window.dispatchEvent(new Event("mousemove"));
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(cfg.onExpired).toHaveBeenCalledTimes(1);
  });

  it("debounces 100 rapid events — only 1 setTimeout scheduled during the burst", async () => {
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const callsBefore = setTimeoutSpy.mock.calls.length;

    // 100 rapid events spread over 100ms, all inside the 1s debounce window.
    for (let i = 0; i < 100; i++) {
      await act(async () => {
        window.dispatchEvent(new Event("mousedown"));
        vi.advanceTimersByTime(1);
      });
    }

    // Only the first event opens a debounce; the other 99 hit the guard.
    // So exactly 1 setTimeout is scheduled during the burst.
    const burstSetTimeoutCalls = setTimeoutSpy.mock.calls.length - callsBefore;
    expect(burstSetTimeoutCalls).toBe(1);
    setTimeoutSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Absolute-lifetime guard
  // -------------------------------------------------------------------------

  it("mounts with sc_session_started_at older than absoluteLifetimeMs → onExpired called", async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    window.localStorage.setItem(SESSION_STARTED_AT_STORAGE_KEY, thirtyOneDaysAgo);
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();

    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    expect(cfg.onExpired).toHaveBeenCalledTimes(1);
  });

  it("mounts with corrupt sc_session_started_at → no fire, DEV warn, no throw", async () => {
    window.localStorage.setItem(SESSION_STARTED_AT_STORAGE_KEY, "not-a-date");
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    // Corrupt value → treat as absent → does NOT fire onExpired on mount.
    expect(cfg.onExpired).not.toHaveBeenCalled();
    // In DEV builds, a warn is emitted. In CI prod builds the branch is
    // dead-code-eliminated, but Vitest runs the DEV branch.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("mounts with no sc_session_started_at → does NOT fire on mount", async () => {
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();

    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    expect(cfg.onExpired).not.toHaveBeenCalled();
  });

  it("mounts with stale key but NO session → does NOT fire (guard only runs when session present)", async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    window.localStorage.setItem(SESSION_STARTED_AT_STORAGE_KEY, thirtyOneDaysAgo);
    // getSession returns no session (default).
    const cfg = buildConfig();

    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    expect(cfg.onExpired).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // onAuthStateChange integration
  // -------------------------------------------------------------------------

  it("SIGNED_IN event persists sc_session_started_at as ISO 8601", async () => {
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await emitAuth("SIGNED_IN", fakeSession);

    const stored = window.localStorage.getItem(SESSION_STARTED_AT_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(Number.isNaN(Date.parse(stored!))).toBe(false);
  });

  it("SIGNED_IN does NOT overwrite an existing sc_session_started_at", async () => {
    const existing = new Date(Date.now() - 60_000).toISOString();
    window.localStorage.setItem(SESSION_STARTED_AT_STORAGE_KEY, existing);
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await emitAuth("SIGNED_IN", fakeSession);

    expect(window.localStorage.getItem(SESSION_STARTED_AT_STORAGE_KEY)).toBe(existing);
  });

  it("SIGNED_OUT event removes sc_session_started_at", async () => {
    window.localStorage.setItem(SESSION_STARTED_AT_STORAGE_KEY, new Date().toISOString());
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await emitAuth("SIGNED_OUT", null);

    expect(window.localStorage.getItem(SESSION_STARTED_AT_STORAGE_KEY)).toBeNull();
  });

  it("SIGNED_OUT cancels an armed idle timer", async () => {
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await emitAuth("SIGNED_OUT", null);

    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS * 2);
    });
    expect(cfg.onExpired).not.toHaveBeenCalled();
  });

  it("SIGNED_IN arms a fresh idle timer", async () => {
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await emitAuth("SIGNED_IN", fakeSession);

    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS);
    });
    expect(cfg.onExpired).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // TOKEN_REFRESHED observability
  // -------------------------------------------------------------------------

  it("TOKEN_REFRESHED emits a structured console.info event", async () => {
    const cfg = buildConfig();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await emitAuth("TOKEN_REFRESHED", fakeSession);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.token_refreshed" }),
    );
    infoSpy.mockRestore();
  });

  it("TOKEN_REFRESHED does NOT reset the idle timer", async () => {
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    // Let the idle clock run for idleMs / 2.
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS / 2);
    });
    await emitAuth("TOKEN_REFRESHED", fakeSession);

    // Advance the remaining half — if TOKEN_REFRESHED had reset the timer,
    // this would NOT fire; but our contract is that refresh is transparent.
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS / 2);
    });
    expect(cfg.onExpired).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  it("unmount removes window listeners and cancels pending timers", async () => {
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();
    const { unmount } = renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    unmount();

    await act(async () => {
      window.dispatchEvent(new Event("mousedown"));
      vi.advanceTimersByTime(IDLE_MS * 5);
    });
    expect(cfg.onExpired).not.toHaveBeenCalled();
  });

  it("unmount unsubscribes from onAuthStateChange", async () => {
    const cfg = buildConfig();
    const { unmount } = renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    unmount();

    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it("calls the caller-provided onExpired (contract: hook does NOT signOut directly)", async () => {
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });
    const cfg = buildConfig();
    renderHook(() => useIdleTimeout(cfg));
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(IDLE_MS);
    });

    expect(cfg.onExpired).toHaveBeenCalledTimes(1);
    // The hook MUST NOT call supabase.auth.signOut directly — that belongs
    // to the caller's onExpired so tests and alt-callers can override.
    expect(signOutMock).not.toHaveBeenCalled();
  });
});
