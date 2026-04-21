import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Supabase mock — captures RPC + signOut calls so we can verify order,
// arguments, and that signOut is still called even when the RPC fails.
// ---------------------------------------------------------------------------

const rpcMock = vi.fn();
const signOutMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
    auth: {
      signOut: (opts?: unknown) => signOutMock(opts),
    },
  },
}));

import {
  AUDIT_EMIT_TIMEOUT_MS,
  purgeSessionData,
  requestSignOut,
  signOutStateRef,
} from "@/features/auth/api/signOut";

describe("requestSignOut", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpcMock.mockReset();
    signOutMock.mockReset();
    signOutStateRef.reason = null;
    rpcMock.mockResolvedValue({ data: null, error: null });
    signOutMock.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("calls emit_session_event RPC then signOut with scope=local (explicit)", async () => {
    const callOrder: string[] = [];
    rpcMock.mockImplementation(() => {
      callOrder.push("rpc");
      return Promise.resolve({ data: null, error: null });
    });
    signOutMock.mockImplementation(() => {
      callOrder.push("signOut");
      return Promise.resolve({ error: null });
    });

    await requestSignOut("explicit");

    expect(rpcMock).toHaveBeenCalledWith("emit_session_event", { p_reason: "explicit" });
    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
    expect(callOrder).toEqual(["rpc", "signOut"]);
  });

  it("uses p_reason=idle when reason is idle", async () => {
    await requestSignOut("idle");
    expect(rpcMock).toHaveBeenCalledWith("emit_session_event", { p_reason: "idle" });
  });

  it("sets signOutStateRef.reason synchronously BEFORE awaiting signOut", async () => {
    let reasonAtRpcCall: string | null | undefined;
    let reasonAtSignOutCall: string | null | undefined;
    rpcMock.mockImplementation(() => {
      reasonAtRpcCall = signOutStateRef.reason;
      return Promise.resolve({ data: null, error: null });
    });
    signOutMock.mockImplementation(() => {
      reasonAtSignOutCall = signOutStateRef.reason;
      return Promise.resolve({ error: null });
    });

    await requestSignOut("explicit");

    expect(reasonAtRpcCall).toBe("explicit");
    expect(reasonAtSignOutCall).toBe("explicit");
    // AuthStateListener clears the ref after reading — the helper leaves it
    // set. A fresh sign-in / sign-out cycle overwrites, not a leak.
    expect(signOutStateRef.reason).toBe("explicit");
  });

  it("drops the second call while a sign-out is already in flight (concurrent guard)", async () => {
    // Simulate the idle timer firing mid-explicit sign-out: first call pins
    // reason='explicit'; a second call with 'idle' must be a no-op so the
    // SIGNED_OUT listener reads the correct reason.
    signOutStateRef.reason = "explicit";

    await requestSignOut("idle");

    expect(rpcMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(signOutStateRef.reason).toBe("explicit");
  });

  it("does NOT throw when the RPC rejects; signOut is still called", async () => {
    rpcMock.mockRejectedValue(new Error("postgres down"));

    await expect(requestSignOut("explicit")).resolves.toBeUndefined();
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("preserves signOutStateRef.reason when signOut rejects but the RPC succeeded", async () => {
    // Network outage path: Supabase-js clears local session regardless, but
    // signOut() still rejects. The helper must leave reason=explicit so the
    // resulting SIGNED_OUT event still picks the right toast.
    signOutMock.mockRejectedValue(new Error("network unreachable"));

    await requestSignOut("explicit");

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutStateRef.reason).toBe("explicit");
  });

  it("does NOT throw when the RPC hangs past 2s; signOut is still called", async () => {
    // RPC never resolves. The helper's internal 2s timeout must fire.
    rpcMock.mockImplementation(() => new Promise(() => {}));

    const promise = requestSignOut("explicit");
    await vi.advanceTimersByTimeAsync(AUDIT_EMIT_TIMEOUT_MS + 1);
    await expect(promise).resolves.toBeUndefined();
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT throw when signOut itself rejects (local state still cleared)", async () => {
    signOutMock.mockRejectedValue(new Error("network unreachable"));
    await expect(requestSignOut("explicit")).resolves.toBeUndefined();
  });

  it("purgeSessionData returns a resolved promise (Story 8.3 placeholder)", async () => {
    await expect(purgeSessionData()).resolves.toBeUndefined();
  });
});
