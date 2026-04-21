// Story 1.5b — useLogin (password flow) unit tests.
//
// PRD v1.3 auth pivot. The hook is now a single-shot signInWithPassword
// mutation; the old phone → OTP → 3-strike state machine no longer exists.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signInWithPasswordMock = vi.fn();
const fromSelectMock = vi.fn();
const fromLimitMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    auth: {
      signInWithPassword: (args: unknown) => signInWithPasswordMock(args),
    },
    from: () => ({
      select: (...selArgs: unknown[]) => {
        fromSelectMock(...selArgs);
        return { limit: (...limitArgs: unknown[]) => fromLimitMock(...limitArgs) };
      },
    }),
  },
}));

import { useLogin } from "@/features/auth/api/useLogin";

const VALID_PHONE = "+221777915898";

describe("useLogin", () => {
  beforeEach(() => {
    signInWithPasswordMock.mockReset();
    fromSelectMock.mockReset();
    fromLimitMock.mockReset();
  });

  it("rejects an invalid phone without hitting Supabase", async () => {
    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn("123", "password!"));
    expect(outcome).toEqual({ kind: "error", code: "phone_invalid" });
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });

  it("rejects an empty password without hitting Supabase", async () => {
    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn(VALID_PHONE, ""));
    expect(outcome).toEqual({ kind: "error", code: "invalid_credentials" });
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });

  it("happy path (memberCount=0) → returns { kind: 'ok', memberCount: 0 }", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: { user: { id: "user-123" } } },
      error: null,
    });
    fromLimitMock.mockResolvedValue({ count: 0, error: null });

    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn(VALID_PHONE, "pw123!"));
    expect(outcome).toEqual({ kind: "ok", userId: "user-123", memberCount: 0 });
    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      phone: VALID_PHONE,
      password: "pw123!",
    });
    expect(fromSelectMock).toHaveBeenCalledWith("id", { count: "exact", head: true });
  });

  it("happy path (memberCount>0) → returns memberCount from query", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: { user: { id: "user-123" } } },
      error: null,
    });
    fromLimitMock.mockResolvedValue({ count: 42, error: null });

    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn(VALID_PHONE, "pw123!"));
    expect(outcome).toEqual({ kind: "ok", userId: "user-123", memberCount: 42 });
  });

  it("post-auth count failure → keeps { kind: 'ok' } with warning", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: { user: { id: "user-123" } } },
      error: null,
    });
    fromLimitMock.mockResolvedValue({ count: null, error: { message: "boom" } });

    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn(VALID_PHONE, "pw123!"));
    expect(outcome).toEqual({
      kind: "ok",
      userId: "user-123",
      memberCount: 1,
      warning: "count_query_failed",
    });
  });

  it("invalid_credentials error → maps to code: 'invalid_credentials'", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", status: 400, message: "Invalid login credentials" },
    });

    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn(VALID_PHONE, "wrong"));
    expect(outcome).toEqual({ kind: "error", code: "invalid_credentials" });
    expect(result.current.error).toBe("invalid_credentials");
  });

  it("429 without a specific code → code: 'rate_limited'", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { status: 429, message: "Too many" },
    });

    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn(VALID_PHONE, "pw123!"));
    expect(outcome).toEqual({ kind: "error", code: "rate_limited" });
  });

  it("explicit over_request_rate_limit code → code: 'rate_limited'", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "over_request_rate_limit", status: 429, message: "Rate" },
    });

    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn(VALID_PHONE, "pw123!"));
    expect(outcome).toEqual({ kind: "error", code: "rate_limited" });
  });

  it("network error (status=0) → code: 'network'", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { status: 0, message: "fetch failed" },
    });

    const { result } = renderHook(() => useLogin());
    const outcome = await act(() => result.current.signIn(VALID_PHONE, "pw123!"));
    expect(outcome).toEqual({ kind: "error", code: "network" });
  });

  it("reset() clears error state", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", status: 400, message: "bad" },
    });
    const { result } = renderHook(() => useLogin());
    await act(() => result.current.signIn(VALID_PHONE, "wrong"));
    expect(result.current.error).toBe("invalid_credentials");
    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
  });
});
