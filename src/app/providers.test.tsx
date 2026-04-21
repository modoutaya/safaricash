import { render } from "@testing-library/react";
import type { AuthChangeEvent, Session, Subscription } from "@supabase/supabase-js";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_IDLE_TIMEOUT_MS, SESSION_STARTED_AT_STORAGE_KEY } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Mocks: supabase-js, react-router-dom, sonner.
// The AuthStateListener mounts two onAuthStateChange subscriptions (the
// Story 1.5 effect + the Story 1.6 useIdleTimeout hook); we capture BOTH
// callbacks in an array so tests can dispatch events to all of them at once.
// ---------------------------------------------------------------------------

const signOutMock = vi.fn();
const getSessionMock = vi.fn();
const unsubscribeMock = vi.fn();

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;
const capturedAuthCallbacks: AuthCallback[] = [];

const onAuthStateChangeMock = vi.fn((cb: AuthCallback) => {
  capturedAuthCallbacks.push(cb);
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

const navigateMock = vi.fn();
const locationRef = { pathname: "/members" };

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationRef,
}));

const toastMock = vi.fn();

vi.mock("sonner", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
  Toaster: () => null,
}));

// ---------------------------------------------------------------------------

import { AuthStateListener } from "@/app/providers";

const fakeSession = { access_token: "jwt", user: { id: "u1" } } as unknown as Session;

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function emitAuth(event: AuthChangeEvent, session: Session | null): Promise<void> {
  await act(async () => {
    for (const cb of capturedAuthCallbacks) {
      cb(event, session);
    }
  });
}

describe("AuthStateListener", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signOutMock.mockReset();
    getSessionMock.mockReset();
    unsubscribeMock.mockReset();
    onAuthStateChangeMock.mockClear();
    capturedAuthCallbacks.length = 0;
    navigateMock.mockReset();
    toastMock.mockReset();
    locationRef.pathname = "/members";
    window.localStorage.clear();
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Story 1.5 regression — cold-load suppression must still work.
  // -------------------------------------------------------------------------

  it("P1: SIGNED_OUT with no prior session → no toast, no navigate (cold load)", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();

    await emitAuth("SIGNED_OUT", null);

    expect(toastMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("P2: SIGNED_IN → SIGNED_OUT → toast + navigate fire", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();

    await emitAuth("SIGNED_IN", fakeSession);
    await emitAuth("SIGNED_OUT", null);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/login", { replace: true });
  });

  it("P3: pathname === /login → no redundant toast/navigate on SIGNED_OUT", async () => {
    locationRef.pathname = "/login";
    render(<AuthStateListener />);
    await flushMicrotasks();

    // Seed a session first (same pattern as Story 1.5 — toast only fires on
    // true session loss, and even then not when already on /login).
    await emitAuth("SIGNED_IN", fakeSession);
    await emitAuth("SIGNED_OUT", null);

    expect(toastMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Story 1.6 — idle timeout drives signOut, which the existing listener
  // catches. End-to-end coverage through the AuthStateListener surface.
  // -------------------------------------------------------------------------

  it("P4: SIGNED_IN → idle IDLE_MS → supabase.auth.signOut() called exactly once", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();
    await emitAuth("SIGNED_IN", fakeSession);

    await act(async () => {
      vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS);
    });

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("P5: idle-triggered SIGNED_OUT fires toast + navigate", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();
    await emitAuth("SIGNED_IN", fakeSession);

    await act(async () => {
      vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS);
    });

    // Simulate Supabase Auth emitting SIGNED_OUT in response to signOut().
    await emitAuth("SIGNED_OUT", null);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/login", { replace: true });
  });

  it("P6: mount with stale sc_session_started_at + active session → signOut on mount", async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    window.localStorage.setItem(SESSION_STARTED_AT_STORAGE_KEY, thirtyOneDaysAgo);
    getSessionMock.mockResolvedValue({ data: { session: fakeSession } });

    render(<AuthStateListener />);
    await flushMicrotasks();

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("P7: both Story 1.5 listener and Story 1.6 idle hook subscribe (2 subscribers)", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();

    expect(onAuthStateChangeMock).toHaveBeenCalledTimes(2);
    expect(capturedAuthCallbacks.length).toBe(2);
  });
});
