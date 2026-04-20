// Story 1.5 — useLogin hook.
//
// State machine for the Flow 5 login experience. Encapsulates:
//   - pre-provisioning gate via check_collector_registered RPC
//   - SMS OTP send/verify via Supabase Auth
//   - 3-strike client-soft lockout (UX guard; Supabase Auth hard-locks at
//     the server via max_frequency + attempt cap)
//   - 30-second resend cooldown counter
//
// Notes:
//   - The hook is navigation-agnostic. It exposes `sendCode`, `verifyCode`,
//     `resendCode` and returns rich results; the calling component decides
//     where to route. This keeps the hook trivially unit-testable without
//     a Router context.
//   - Failed-attempt counter lives in component-local state only. A page
//     reload resets it — documented + intentional per AC #8 (the real
//     abuse defense is server-side in Supabase Auth).
//   - The hook never throws from `sendCode`; "not registered" is a
//     first-class `SendCodeResult` discriminant so callers can branch
//     without try/catch around a non-error control flow.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";
import { OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS } from "@/lib/constants";
import { formatE164, isValidSenegalPhone } from "@/features/auth/ui/phoneFormat";

export type LoginStep = "phone" | "otp" | "locked";

export type LoginErrorCode =
  | "phone_invalid"
  | "delivery_failed"
  | "network"
  | "invalid"
  | "expired"
  | "locked"
  | "unknown";

export type SendCodeResult =
  | { kind: "registered" }
  | { kind: "not_registered"; phone: string }
  | { kind: "error"; code: LoginErrorCode };

/** Optional non-fatal warning raised by verifyCode — the session IS established
 *  but some post-auth query degraded. Caller can surface a toast without
 *  blocking the post-login navigation. */
export type VerifyWarning = "count_query_failed";

export type VerifyCodeResult =
  | { kind: "ok"; userId: string; memberCount: number; warning?: VerifyWarning }
  | { kind: "error"; code: LoginErrorCode };

export type ResendCodeResult =
  | { kind: "ok" }
  | { kind: "cooldown"; secondsRemaining: number }
  | { kind: "error"; code: LoginErrorCode };

export type UseLoginReturn = {
  step: LoginStep;
  phone: string;
  attemptCount: number;
  cooldownSecondsRemaining: number;
  error: LoginErrorCode | null;
  isPending: boolean;
  sendCode: (rawPhone: string) => Promise<SendCodeResult>;
  verifyCode: (otp: string) => Promise<VerifyCodeResult>;
  resendCode: () => Promise<ResendCodeResult>;
  reset: () => void;
};

/** Minimal Supabase AuthError shape we care about — Supabase 2.x uses
 *  `code` as a machine-readable slug; fall back to status if absent. */
function classifyAuthError(err: AuthError | null): LoginErrorCode {
  if (!err) return "unknown";
  const code = (err as AuthError & { code?: string }).code ?? "";
  switch (code) {
    case "otp_expired":
      return "expired";
    case "otp_disabled":
    case "invalid_credentials":
    case "otp_invalid":
      return "invalid";
    case "over_sms_send_rate_limit":
    case "over_request_rate_limit":
      return "delivery_failed";
    default:
      break;
  }
  // Supabase Auth's generic "Invalid login credentials" / verification
  // failure paths hit here; treat as invalid. Network errors often surface
  // with status=0 (browser) or without a status at all.
  const status = err.status ?? 0;
  if (status === 0) return "network";
  if (status === 410) return "expired";
  // 429 without a specific rate-limit code: fold into delivery_failed rather
  // than arming the client soft lockout (which is a 3-strike OTP guard, not
  // a transient-429 semantic). Supabase Auth's server-side hard lockout
  // still applies independently.
  if (status === 429) return "delivery_failed";
  return "invalid";
}

export function useLogin(): UseLoginReturn {
  const [step, setStep] = useState<LoginStep>("phone");
  const [phone, setPhone] = useState("");
  const [attemptCount, setAttemptCount] = useState(0);
  const [cooldownSecondsRemaining, setCooldownSecondsRemaining] = useState(0);
  const [error, setError] = useState<LoginErrorCode | null>(null);
  const [isPending, setIsPending] = useState(false);

  // Track the lockout timer so a second lockout / unmount cleans it up.
  const lockoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Absolute wall-clock target for the resend cooldown — survives tab
  // backgrounding / laptop sleep (browsers throttle timer ticks, so a naive
  // decrement-every-second counter drifts; comparing to Date.now() does not).
  const cooldownTargetMsRef = useRef<number>(0);
  // Synchronous in-flight guard. `isPending` state flips through React's
  // commit cycle, so a second keypress / double-click can re-enter before
  // the disabled UI actually renders. This ref is the single source of
  // truth within one render tick.
  const inFlightRef = useRef(false);

  // Clean up timers on unmount — otherwise a React.StrictMode double-mount
  // in dev leaks interval callbacks referencing stale setState closures.
  useEffect(() => {
    return () => {
      if (lockoutTimerRef.current) clearTimeout(lockoutTimerRef.current);
      if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    };
  }, []);

  const startCooldown = useCallback(() => {
    if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    cooldownTargetMsRef.current = Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000;
    setCooldownSecondsRemaining(OTP_RESEND_COOLDOWN_SECONDS);
    cooldownIntervalRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((cooldownTargetMsRef.current - Date.now()) / 1000));
      setCooldownSecondsRemaining(remaining);
      if (remaining === 0) {
        if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
        cooldownIntervalRef.current = null;
      }
    }, 1000);
  }, []);

  const armLockout = useCallback(() => {
    setStep("locked");
    setError("locked");
    if (lockoutTimerRef.current) clearTimeout(lockoutTimerRef.current);
    lockoutTimerRef.current = setTimeout(
      () => {
        setStep("otp");
        setAttemptCount(0);
        setError(null);
        lockoutTimerRef.current = null;
      },
      // OTP_LOCKOUT_MINUTES = 5 min. Use constants to keep client + edge
      // function in sync.
      5 * 60 * 1000,
    );
  }, []);

  const sendCode = useCallback(
    async (rawPhone: string): Promise<SendCodeResult> => {
      // Synchronous re-entrancy guard: a double-click or second Enter fires
      // handleSubmit twice before React commits isPending=true.
      if (inFlightRef.current) {
        return { kind: "error", code: "unknown" };
      }
      setError(null);
      const normalized = formatE164(rawPhone);
      if (!isValidSenegalPhone(normalized)) {
        setError("phone_invalid");
        return { kind: "error", code: "phone_invalid" };
      }

      inFlightRef.current = true;
      setIsPending(true);
      try {
        // Pre-provisioning gate — cheap RPC, no Termii cost on unknown phones.
        const { data: registered, error: rpcError } = await supabase.rpc(
          "check_collector_registered",
          { p_phone: normalized },
        );
        if (rpcError) {
          // Network faults typically surface with "fetch" / "Failed to fetch"
          // in the message. Anything else — PGRST permission, Postgres 5xx,
          // PostgREST timeout — is a delivery failure from the user's POV.
          // Returning "unknown" previously fell through to a nonsensical
          // "Code incorrect" copy in LoginForm.
          const msg = rpcError.message?.toLowerCase() ?? "";
          const code: LoginErrorCode = msg.includes("fetch") ? "network" : "delivery_failed";
          setError(code);
          return { kind: "error", code };
        }
        if (registered !== true) {
          return { kind: "not_registered", phone: normalized };
        }

        const { error: otpError } = await supabase.auth.signInWithOtp({
          phone: normalized,
          options: {
            channel: "sms",
            shouldCreateUser: false,
          },
        });
        if (otpError) {
          const code = classifyAuthError(otpError);
          setError(code);
          return { kind: "error", code };
        }

        setPhone(normalized);
        setStep("otp");
        setAttemptCount(0);
        startCooldown();
        return { kind: "registered" };
      } finally {
        inFlightRef.current = false;
        setIsPending(false);
      }
    },
    [startCooldown],
  );

  const verifyCode = useCallback(
    async (otp: string): Promise<VerifyCodeResult> => {
      if (step === "locked") {
        return { kind: "error", code: "locked" };
      }
      // Re-entrancy guard: handleChange auto-submits on the 6th digit AND
      // a keyboard Enter can fire handleSubmit at the same edge. Without a
      // synchronous guard both branches call verifyCode and each burns a
      // strike on invalid — the user is surprise-locked after two wrong
      // guesses instead of three.
      if (inFlightRef.current) {
        return { kind: "error", code: "unknown" };
      }
      setError(null);
      inFlightRef.current = true;
      setIsPending(true);
      try {
        const { data, error: otpError } = await supabase.auth.verifyOtp({
          phone,
          token: otp,
          type: "sms",
        });
        if (otpError || !data.session?.user) {
          // Classify on the AuthError when present; treat the rare
          // no-error-no-session case as invalid so it counts toward the
          // 3-strike lockout and renders a real error message (otherwise
          // the UI would silently clear the input with no feedback).
          const code = otpError ? classifyAuthError(otpError) : "invalid";
          if (code === "invalid") {
            const nextCount = attemptCount + 1;
            setAttemptCount(nextCount);
            if (nextCount >= OTP_MAX_ATTEMPTS) {
              armLockout();
              return { kind: "error", code: "locked" };
            }
          }
          setError(code);
          return { kind: "error", code };
        }

        const userId = data.session.user.id;
        // Count-only query — minimal egress, returns 0 rows + count meta.
        const { count, error: countError } = await supabase
          .from("members")
          .select("id", { count: "exact", head: true })
          .limit(1);
        if (countError) {
          // Session IS established. Keep navigation alive (fail-to-dashboard)
          // but raise a non-fatal warning so the caller can surface a toast
          // — the user should know the member list failed to load, not be
          // silently routed to a wrong post-login destination.
          return {
            kind: "ok",
            userId,
            memberCount: 1,
            warning: "count_query_failed",
          };
        }
        return { kind: "ok", userId, memberCount: count ?? 0 };
      } finally {
        inFlightRef.current = false;
        setIsPending(false);
      }
    },
    [phone, step, attemptCount, armLockout],
  );

  const resendCode = useCallback(async (): Promise<ResendCodeResult> => {
    if (cooldownSecondsRemaining > 0) {
      return { kind: "cooldown", secondsRemaining: cooldownSecondsRemaining };
    }
    // Defense-in-depth: the OtpStep disables the resend button while
    // step === "locked", but any future programmatic caller (e.g. a keyboard
    // shortcut, a dev tool) must not dispatch an SMS during lockout.
    if (step === "locked") {
      return { kind: "error", code: "locked" };
    }
    if (!phone) {
      return { kind: "error", code: "unknown" };
    }
    if (inFlightRef.current) {
      return { kind: "error", code: "unknown" };
    }
    setError(null);
    inFlightRef.current = true;
    setIsPending(true);
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        phone,
        options: { channel: "sms", shouldCreateUser: false },
      });
      if (otpError) {
        const code = classifyAuthError(otpError);
        setError(code);
        return { kind: "error", code };
      }
      setAttemptCount(0);
      startCooldown();
      return { kind: "ok" };
    } finally {
      inFlightRef.current = false;
      setIsPending(false);
    }
  }, [cooldownSecondsRemaining, step, phone, startCooldown]);

  const reset = useCallback(() => {
    if (lockoutTimerRef.current) {
      clearTimeout(lockoutTimerRef.current);
      lockoutTimerRef.current = null;
    }
    if (cooldownIntervalRef.current) {
      clearInterval(cooldownIntervalRef.current);
      cooldownIntervalRef.current = null;
    }
    setStep("phone");
    setPhone("");
    setAttemptCount(0);
    setCooldownSecondsRemaining(0);
    setError(null);
  }, []);

  return {
    step,
    phone,
    attemptCount,
    cooldownSecondsRemaining,
    error,
    isPending,
    sendCode,
    verifyCode,
    resendCode,
    reset,
  };
}
