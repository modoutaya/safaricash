// Story 6.6 — useResendHistory mutation hook.
//
// TanStack `useMutation` calling the sms-resend-history Edge Function.
// The Edge Function does verify-password + enqueue_resend_history under
// the caller's JWT and returns { enqueued, reason }.
//
// Errors are mapped to the typed `ResendHistoryError` so the dialog can
// branch on `error.code` without parsing strings.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";

import { supabase } from "@/infrastructure/supabase/client";

import { MEMBER_PROFILE_QUERY_KEY } from "../types";

export type ResendHistoryReason = "opt_out" | "no_phone" | "no_transactions" | null;

export interface ResendHistoryResult {
  enqueued: number;
  reason: ResendHistoryReason;
}

export interface ResendHistoryInput {
  memberId: string;
  cycleId: string;
  password: string;
}

export type ResendHistoryErrorCode =
  | "auth_unauthenticated"
  | "credentials_invalid"
  | "rate_limited"
  | "request_invalid"
  | "not_found"
  | "internal_unexpected"
  | "network"
  | "unknown";

export class ResendHistoryError extends Error {
  public readonly code: ResendHistoryErrorCode;
  constructor(code: ResendHistoryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ResendHistoryError";
  }
}

interface FunctionsHttpErrorLike {
  context?: Response | { status?: number };
  message?: string;
}

async function classifyError(err: FunctionsHttpErrorLike): Promise<ResendHistoryError> {
  const ctx = err.context;
  let status: number | undefined;
  let problemType: string | undefined;
  if (ctx && typeof ctx === "object") {
    if ("status" in ctx && typeof ctx.status === "number") {
      status = ctx.status;
    }
    // FunctionsHttpError.context is the upstream Response — try to read the
    // RFC 7807 body for `type` (carries the canonical problem code).
    if (typeof (ctx as Response).json === "function") {
      try {
        const body = await (ctx as Response).clone().json();
        if (body && typeof body.type === "string") {
          problemType = body.type;
        }
      } catch {
        // Body wasn't JSON — fall back to status-based mapping.
      }
    }
  }

  if (problemType?.includes("credentials_invalid")) {
    return new ResendHistoryError("credentials_invalid", err.message ?? "Invalid password");
  }
  if (problemType?.includes("rate_limited") || status === 429) {
    return new ResendHistoryError("rate_limited", err.message ?? "Too many attempts");
  }
  if (problemType?.includes("auth_unauthenticated") || status === 401) {
    // Defaults to credentials_invalid since the dialog already authenticated
    // via JWT; a 401 here is almost always a wrong password.
    return new ResendHistoryError("credentials_invalid", err.message ?? "Invalid credentials");
  }
  if (problemType?.includes("not_found") || status === 404) {
    return new ResendHistoryError("not_found", err.message ?? "Member or cycle not found");
  }
  if (problemType?.includes("request_invalid") || status === 400) {
    return new ResendHistoryError("request_invalid", err.message ?? "Invalid request");
  }
  if (problemType?.includes("internal_unexpected") || (status && status >= 500)) {
    return new ResendHistoryError("internal_unexpected", err.message ?? "Server error");
  }
  // Code-review patch (P6): use runtime class identity instead of a
  // locale-dependent substring match on the message. supabase-js wraps
  // network failures as FunctionsFetchError; a raw fetch reject is a
  // TypeError. Both are reliable across browsers and locales.
  const errName = (err as { name?: string })?.name;
  if (errName === "FunctionsFetchError" || err instanceof TypeError) {
    return new ResendHistoryError("network", err.message ?? "Network error");
  }
  return new ResendHistoryError("unknown", err.message ?? "Unknown error");
}

export type UseResendHistoryReturn = UseMutationResult<
  ResendHistoryResult,
  ResendHistoryError,
  ResendHistoryInput
>;

export function useResendHistory(): UseResendHistoryReturn {
  const inFlightRef = useRef(false);
  const queryClient = useQueryClient();

  return useMutation<ResendHistoryResult, ResendHistoryError, ResendHistoryInput>({
    mutationFn: async ({ memberId, cycleId, password }): Promise<ResendHistoryResult> => {
      if (inFlightRef.current) {
        throw new ResendHistoryError("unknown", "resend already in flight");
      }
      inFlightRef.current = true;
      try {
        const { data, error } = await supabase.functions.invoke<ResendHistoryResult>(
          "sms-resend-history",
          {
            body: { member_id: memberId, cycle_id: cycleId, password },
          },
        );
        if (error) {
          throw await classifyError(error as FunctionsHttpErrorLike);
        }
        if (!data || typeof data.enqueued !== "number") {
          throw new ResendHistoryError("unknown", "Malformed response from sms-resend-history");
        }
        return {
          enqueued: data.enqueued,
          reason: (data.reason ?? null) as ResendHistoryReason,
        };
      } finally {
        inFlightRef.current = false;
      }
    },
    // Code-review patch (P1, AC #12): refresh the member's profile query
    // (which backs the transaction list) so Story 6.7's per-transaction
    // status indicator can read fresh sms_queue state after a resend.
    onSuccess: (result, { memberId }) => {
      if (result.enqueued > 0) {
        void queryClient.invalidateQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, memberId] });
      }
    },
  });
}
