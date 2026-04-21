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
// Story 1.7 routes idle sign-out through requestSignOut, which calls the
// emit_session_event RPC before signOut — so the supabase mock must cover
// rpc as well.
// ---------------------------------------------------------------------------

const rpcMock = vi.fn();
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
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
    auth: {
      signOut: (opts?: unknown) => signOutMock(opts),
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

import { AuthStateListener, queryClient } from "@/app/providers";
import { signOutStateRef } from "@/features/auth/api/signOut";
import frJson from "@/i18n/fr.json";

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
    rpcMock.mockReset();
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
    rpcMock.mockResolvedValue({ data: null, error: null });
    signOutMock.mockResolvedValue({ error: null });
    signOutStateRef.reason = null;
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

    await emitAuth("SIGNED_IN", fakeSession);
    await emitAuth("SIGNED_OUT", null);

    expect(toastMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Story 1.6 — idle timeout drives signOut, which the existing listener
  // catches. Story 1.7 routes through requestSignOut("idle"): rpc then signOut.
  // -------------------------------------------------------------------------

  it("P4: SIGNED_IN → idle IDLE_MS → supabase.auth.signOut() called exactly once", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();
    await emitAuth("SIGNED_IN", fakeSession);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS);
    });

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
    // Idle path calls the audit RPC with reason="idle".
    expect(rpcMock).toHaveBeenCalledWith("emit_session_event", { p_reason: "idle" });
  });

  it("P5: idle-triggered SIGNED_OUT fires toast + navigate", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();
    await emitAuth("SIGNED_IN", fakeSession);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS);
    });
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

  // -------------------------------------------------------------------------
  // Story 1.7 — queryClient.clear + reason-aware toast + ref lifecycle.
  // -------------------------------------------------------------------------

  it("P8: queryClient.clear() is called when SIGNED_OUT follows an active session", async () => {
    const clearSpy = vi.spyOn(queryClient, "clear");
    render(<AuthStateListener />);
    await flushMicrotasks();

    await emitAuth("SIGNED_IN", fakeSession);
    clearSpy.mockClear();
    await emitAuth("SIGNED_OUT", null);

    expect(clearSpy).toHaveBeenCalledTimes(1);
    clearSpy.mockRestore();
  });

  it("P9: explicit sign-out path toasts settings.signed_out_success", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();

    await emitAuth("SIGNED_IN", fakeSession);
    signOutStateRef.reason = "explicit";
    await emitAuth("SIGNED_OUT", null);

    expect(toastMock).toHaveBeenCalledTimes(1);
    // Assert on the i18n-resolved value looked up from fr.json so copy
    // tweaks don't silently break this test.
    expect(toastMock).toHaveBeenCalledWith(frJson.settings.signed_out_success);
  });

  it("P10: idle sign-out path toasts login.session_expired_toast", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();

    await emitAuth("SIGNED_IN", fakeSession);
    signOutStateRef.reason = "idle";
    await emitAuth("SIGNED_OUT", null);

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(frJson.login.session_expired_toast);
  });

  it("P11: signOutStateRef.reason is cleared after the SIGNED_OUT handler runs", async () => {
    render(<AuthStateListener />);
    await flushMicrotasks();

    await emitAuth("SIGNED_IN", fakeSession);
    signOutStateRef.reason = "explicit";
    await emitAuth("SIGNED_OUT", null);

    expect(signOutStateRef.reason).toBeNull();
  });

  it("P12: cold-load SIGNED_OUT preserves signOutStateRef.reason (in-flight requestSignOut)", async () => {
    // A concurrent `requestSignOut("explicit")` just set the ref; a cold-load
    // SIGNED_OUT fires before `hadSessionRef` is seeded. The listener MUST
    // NOT wipe the reason — the "real" SIGNED_OUT (from signOut()) arrives
    // next and must still see "explicit".
    render(<AuthStateListener />);
    await flushMicrotasks();

    signOutStateRef.reason = "explicit";
    await emitAuth("SIGNED_OUT", null);

    expect(signOutStateRef.reason).toBe("explicit");
    expect(toastMock).not.toHaveBeenCalled();
  });
});
