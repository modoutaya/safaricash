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

export type VerifyCodeResult =
  | { kind: "ok"; userId: string; memberCount: number }
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
  if (status === 429) return "locked";
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
    setCooldownSecondsRemaining(OTP_RESEND_COOLDOWN_SECONDS);
    cooldownIntervalRef.current = setInterval(() => {
      setCooldownSecondsRemaining((prev) => {
        if (prev <= 1) {
          if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
          cooldownIntervalRef.current = null;
          return 0;
        }
        return prev - 1;
      });
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
      setError(null);
      const normalized = formatE164(rawPhone);
      if (!isValidSenegalPhone(normalized)) {
        setError("phone_invalid");
        return { kind: "error", code: "phone_invalid" };
      }

      setIsPending(true);
      try {
        // Pre-provisioning gate — cheap RPC, no Termii cost on unknown phones.
        const { data: registered, error: rpcError } = await supabase.rpc(
          "check_collector_registered",
          { p_phone: normalized },
        );
        if (rpcError) {
          const code: LoginErrorCode = rpcError.message?.toLowerCase().includes("fetch")
            ? "network"
            : "unknown";
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
      setError(null);
      setIsPending(true);
      try {
        const { data, error: otpError } = await supabase.auth.verifyOtp({
          phone,
          token: otp,
          type: "sms",
        });
        if (otpError || !data.session?.user) {
          const code = classifyAuthError(otpError);
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
          // Session IS established. Post-login nav should still succeed;
          // degrade gracefully to assuming there are members (so we route
          // to dashboard, not the empty state — a safer guess).
          return { kind: "ok", userId, memberCount: 1 };
        }
        return { kind: "ok", userId, memberCount: count ?? 0 };
      } finally {
        setIsPending(false);
      }
    },
    [phone, step, attemptCount, armLockout],
  );

  const resendCode = useCallback(async (): Promise<ResendCodeResult> => {
    if (cooldownSecondsRemaining > 0) {
      return { kind: "cooldown", secondsRemaining: cooldownSecondsRemaining };
    }
    if (!phone) {
      return { kind: "error", code: "unknown" };
    }
    setError(null);
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
      setIsPending(false);
    }
  }, [cooldownSecondsRemaining, phone, startCooldown]);

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
