// Story 1.5b — useLogin hook (password flow).
//
// Single-shot sign-in against Supabase `signInWithPassword`. PRD v1.3
// pivoted the auth critical path away from SMS-OTP (Termii KYC blocker);
// this hook replaces the old phone → OTP → 3-strike state machine with a
// single mutation. Server-side abuse defence is Supabase Auth's native
// per-identifier rate limit — no client lockout, no resend cooldown,
// no pre-check RPC, no Termii dependency.
//
// The post-auth first-login branching (zero members → /members empty
// state, otherwise /dashboard) is preserved because it is a distinct
// UX value unit from the auth mechanism.

import { useCallback, useRef, useState } from "react";
import type { AuthError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";
import { formatE164, isValidSenegalPhone } from "@/features/auth/ui/phoneFormat";

export type LoginErrorCode =
  | "phone_invalid"
  | "invalid_credentials"
  | "rate_limited"
  | "network"
  | "unknown";

/** Non-fatal warning raised when the session IS established but the
 *  post-auth `members.count` query degraded. Caller can toast and still
 *  navigate — the collector is signed in. */
export type VerifyWarning = "count_query_failed";

export type SignInResult =
  | { kind: "ok"; userId: string; memberCount: number; warning?: VerifyWarning }
  | { kind: "error"; code: LoginErrorCode };

export type UseLoginReturn = {
  error: LoginErrorCode | null;
  isPending: boolean;
  signIn: (rawPhone: string, password: string) => Promise<SignInResult>;
  reset: () => void;
};

/** Map Supabase AuthError → translatable LoginErrorCode. Supabase-internal
 *  messages are never surfaced to the UI. */
function classifyAuthError(err: AuthError | null): LoginErrorCode {
  if (!err) return "unknown";
  const code = (err as AuthError & { code?: string }).code ?? "";
  if (code === "invalid_credentials") return "invalid_credentials";
  if (
    code === "over_email_send_rate_limit" ||
    code === "over_sms_send_rate_limit" ||
    code === "over_request_rate_limit"
  ) {
    return "rate_limited";
  }
  const status = err.status ?? 0;
  if (status === 0) return "network";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 401) return "invalid_credentials";
  return "unknown";
}

export function useLogin(): UseLoginReturn {
  const [error, setError] = useState<LoginErrorCode | null>(null);
  const [isPending, setIsPending] = useState(false);

  // Synchronous re-entrancy guard: a double-tap on "Se connecter" or an
  // Enter press at the wrong moment would otherwise enqueue two parallel
  // signInWithPassword calls before React commits isPending=true. Each
  // would burn one entry against Supabase's per-identifier rate limit.
  const inFlightRef = useRef(false);

  const signIn = useCallback(async (rawPhone: string, password: string): Promise<SignInResult> => {
    if (inFlightRef.current) return { kind: "error", code: "unknown" };
    setError(null);

    const normalized = formatE164(rawPhone);
    if (!isValidSenegalPhone(normalized)) {
      setError("phone_invalid");
      return { kind: "error", code: "phone_invalid" };
    }
    if (password.length === 0) {
      setError("invalid_credentials");
      return { kind: "error", code: "invalid_credentials" };
    }

    inFlightRef.current = true;
    setIsPending(true);
    try {
      const { data, error: authErr } = await supabase.auth.signInWithPassword({
        phone: normalized,
        password,
      });
      if (authErr || !data.session?.user) {
        const code = authErr ? classifyAuthError(authErr) : "invalid_credentials";
        setError(code);
        return { kind: "error", code };
      }

      const userId = data.session.user.id;
      // Count-only query — minimal egress, returns 0 rows + count meta.
      // Drives the "zero members → /members empty state" first-login UX
      // preserved from Story 1.5 (independent of the auth method change).
      const { count, error: countError } = await supabase
        .from("members")
        .select("id", { count: "exact", head: true })
        .limit(1);
      if (countError) {
        // Session IS established. Fall back to /dashboard and let the
        // caller toast — never silently misroute on post-login failure.
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
  }, []);

  const reset = useCallback(() => {
    setError(null);
  }, []);

  return { error, isPending, signIn, reset };
}
