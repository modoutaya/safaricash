import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Supabase client mock. The hook pulls `supabase` from
// @/infrastructure/supabase/client, so we stub the module before import.
// ---------------------------------------------------------------------------

const rpcMock = vi.fn();
const signInWithOtpMock = vi.fn();
const verifyOtpMock = vi.fn();

const fromSelectMock = vi.fn();
const fromLimitMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
    auth: {
      signInWithOtp: (args: unknown) => signInWithOtpMock(args),
      verifyOtp: (args: unknown) => verifyOtpMock(args),
    },
    from: () => ({
      select: (...selArgs: unknown[]) => {
        fromSelectMock(...selArgs);
        return {
          limit: (...limitArgs: unknown[]) => fromLimitMock(...limitArgs),
        };
      },
    }),
  },
}));

import { useLogin } from "@/features/auth/api/useLogin";

// ---------------------------------------------------------------------------

describe("useLogin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpcMock.mockReset();
    signInWithOtpMock.mockReset();
    verifyOtpMock.mockReset();
    fromSelectMock.mockReset();
    fromLimitMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("rejects an invalid phone without calling Supabase", async () => {
    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.sendCode("123"));
    expect(outcome).toEqual({ kind: "error", code: "phone_invalid" });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });

  it("short-circuits on non-registered phones (no Termii cost)", async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });
    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.sendCode("+221777915898"));
    expect(outcome).toEqual({ kind: "not_registered", phone: "+221777915898" });
    expect(signInWithOtpMock).not.toHaveBeenCalled();
    expect(result.current.step).toBe("phone");
  });

  it("happy path: RPC=true → signInWithOtp → step=otp + cooldown arms", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.sendCode("+221777915898"));
    expect(outcome).toEqual({ kind: "registered" });
    expect(result.current.step).toBe("otp");
    expect(result.current.phone).toBe("+221777915898");
    expect(result.current.cooldownSecondsRemaining).toBe(30);
    expect(signInWithOtpMock).toHaveBeenCalledWith({
      phone: "+221777915898",
      options: { channel: "sms", shouldCreateUser: false },
    });
  });

  it("cooldown counts down from 30 → 0 over 30s", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useLogin());
    await act(() => result.current.sendCode("+221777915898"));
    expect(result.current.cooldownSecondsRemaining).toBe(30);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.cooldownSecondsRemaining).toBe(20);
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(result.current.cooldownSecondsRemaining).toBe(0);
  });

  it("resendCode blocked while cooldown > 0", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useLogin());
    await act(() => result.current.sendCode("+221777915898"));
    const resend = await act(() => result.current.resendCode());
    expect(resend.kind).toBe("cooldown");
    // signInWithOtp called only once — the resend did NOT hit Supabase.
    expect(signInWithOtpMock).toHaveBeenCalledTimes(1);
  });

  it("resendCode fires signInWithOtp once cooldown elapses", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useLogin());
    await act(() => result.current.sendCode("+221777915898"));
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    const outcome = await act(() => result.current.resendCode());
    expect(outcome).toEqual({ kind: "ok" });
    expect(signInWithOtpMock).toHaveBeenCalledTimes(2);
    expect(result.current.cooldownSecondsRemaining).toBe(30);
  });

  it("3 consecutive invalid OTPs → step=locked", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    verifyOtpMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", status: 401, message: "Invalid" },
    });
    const { result } = renderHook(() => useLogin());
    await act(() => result.current.sendCode("+221777915898"));

    for (let i = 0; i < 3; i++) {
      await act(() => result.current.verifyCode("000000"));
    }
    expect(result.current.step).toBe("locked");
    expect(result.current.attemptCount).toBe(3);
    expect(result.current.error).toBe("locked");
  });

  it("lockout self-clears after 5 minutes", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    verifyOtpMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", status: 401, message: "Invalid" },
    });
    const { result } = renderHook(() => useLogin());
    await act(() => result.current.sendCode("+221777915898"));
    for (let i = 0; i < 3; i++) {
      await act(() => result.current.verifyCode("000000"));
    }
    expect(result.current.step).toBe("locked");

    await act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      return Promise.resolve();
    });
    expect(result.current.step).toBe("otp");
    expect(result.current.attemptCount).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it("verifyCode success → returns memberCount from the count query", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    verifyOtpMock.mockResolvedValue({
      data: { session: { user: { id: "user-123" } } },
      error: null,
    });
    fromLimitMock.mockResolvedValue({ count: 0, error: null });

    const { result } = renderHook(() => useLogin());
    await act(() => result.current.sendCode("+221777915898"));
    const outcome = await act(() => result.current.verifyCode("123456"));
    expect(outcome).toEqual({ kind: "ok", userId: "user-123", memberCount: 0 });
    expect(fromSelectMock).toHaveBeenCalledWith("id", { count: "exact", head: true });
  });

  it("classifies otp_expired error code correctly", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    verifyOtpMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "otp_expired", status: 410, message: "Expired" },
    });
    const { result } = renderHook(() => useLogin());
    await act(() => result.current.sendCode("+221777915898"));
    const outcome = await act(() => result.current.verifyCode("000000"));
    expect(outcome).toEqual({ kind: "error", code: "expired" });
    expect(result.current.attemptCount).toBe(0); // expired doesn't strike
  });

  it("RPC network error → code=network, no Termii send", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "fetch failed", code: "NETWORK" },
    });
    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.sendCode("+221777915898"));
    expect(outcome).toEqual({ kind: "error", code: "network" });
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });

  it("reset() returns hook to initial state", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useLogin());
    await act(() => result.current.sendCode("+221777915898"));
    expect(result.current.step).toBe("otp");
    act(() => result.current.reset());
    expect(result.current.step).toBe("phone");
    expect(result.current.phone).toBe("");
    expect(result.current.cooldownSecondsRemaining).toBe(0);
  });
});
