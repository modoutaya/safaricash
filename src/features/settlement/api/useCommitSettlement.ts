// Story 7.4 — useCommitSettlement mutation hook.
//
// TanStack `useMutation` calling the cycle-settlement Edge Function (FR21 +
// FR5 + NFR-R3). The Edge Function does:
//   1. JWT auth check.
//   2. verifyPassword (FR5 re-auth gate).
//   3. commit_cycle_settlement RPC under the caller's JWT — atomic transaction
//      that asserts cycle.status='completed', recomputes payout server-side,
//      cross-checks vs. expected_payout (NFR-R3 zero-tolerance), inserts a
//      synthetic kind='settlement' transaction (fires settlement SMS via the
//      existing trigger), and flips cycle.status='settled' (fires the
//      cycle.settled audit event via the existing trigger).
//
// On success we invalidate the member-profile query — the settlement flips
// cycle.status and inserts a new transaction; the cached profile MUST refetch
// so the "Clôturer le cycle" CTA disappears + the transaction history grows.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";

import { supabase } from "@/infrastructure/supabase/client";

import { MEMBER_PROFILE_QUERY_KEY } from "@/features/member";

import { CommitSettlementError } from "./commitSettlementError";

export interface CommitSettlementResult {
  ok: true;
  settlement_transaction_id: string;
  settled_payout: number;
  settled_at: string;
}

export interface CommitSettlementInput {
  memberId: string;
  cycleId: string;
  /** Client-computed payout (Story 7.1's `settle()` value). Server cross-checks. */
  expectedPayout: number;
  password: string;
}

interface FunctionsHttpErrorLike {
  context?: Response | { status?: number };
  message?: string;
}

async function classifyError(err: FunctionsHttpErrorLike): Promise<CommitSettlementError> {
  const ctx = err.context;
  let status: number | undefined;
  let problemType: string | undefined;
  let detail: string | undefined;
  let serverPayoutFromBody: number | undefined;

  if (ctx && typeof ctx === "object") {
    if ("status" in ctx && typeof ctx.status === "number") {
      status = ctx.status;
    }
    if (typeof (ctx as Response).json === "function") {
      try {
        const body = await (ctx as Response).clone().json();
        if (body && typeof body.type === "string") {
          problemType = body.type;
        }
        if (body && typeof body.detail === "string") {
          detail = body.detail;
        }
        // Parse server_payout from the detail when present (informational —
        // the Edge Function logs but currently doesn't echo it in the body).
        if (body && typeof body.server_payout === "number") {
          serverPayoutFromBody = body.server_payout;
        }
      } catch {
        // Body wasn't JSON — fall back to status + problemType mapping.
      }
    }
  }

  if (problemType?.includes("payout_mismatch") || status === 409) {
    // 409 with payout_mismatch (preferred branch). Cycle_not_settleable also
    // returns 409 — disambiguate by type if available, else fall to detail.
    if (problemType?.includes("cycle_not_settleable")) {
      return new CommitSettlementError(
        "cycle_not_settleable",
        err.message ?? "Cycle not settleable",
      );
    }
    if (problemType?.includes("payout_mismatch") || detail?.includes("payout")) {
      return new CommitSettlementError(
        "payout_mismatch",
        err.message ?? "Payout mismatch",
        serverPayoutFromBody,
      );
    }
    // 409 without a recognisable type → default to cycle_not_settleable
    // (the more recoverable state — user reloads the page).
    return new CommitSettlementError("cycle_not_settleable", err.message ?? "Cycle not settleable");
  }
  if (problemType?.includes("credentials_invalid")) {
    return new CommitSettlementError("credentials_invalid", err.message ?? "Invalid password");
  }
  if (problemType?.includes("rate_limited") || status === 429) {
    return new CommitSettlementError("rate_limited", err.message ?? "Too many attempts");
  }
  if (problemType?.includes("auth_unauthenticated") || status === 401) {
    return new CommitSettlementError("credentials_invalid", err.message ?? "Invalid credentials");
  }
  if (problemType?.includes("not_found") || status === 404) {
    return new CommitSettlementError("not_found", err.message ?? "Cycle not found");
  }
  if (problemType?.includes("request_invalid") || status === 400) {
    return new CommitSettlementError("request_invalid", err.message ?? "Invalid request");
  }
  if (problemType?.includes("internal_unexpected") || (status && status >= 500)) {
    return new CommitSettlementError("internal_unexpected", err.message ?? "Server error");
  }
  // Network failure detection — same dual-check as Story 6.6 P6.
  const errName = (err as { name?: string })?.name;
  if (errName === "FunctionsFetchError" || err instanceof TypeError) {
    return new CommitSettlementError("network", err.message ?? "Network error");
  }
  return new CommitSettlementError("unknown", err.message ?? "Unknown error");
}

export type UseCommitSettlementReturn = UseMutationResult<
  CommitSettlementResult,
  CommitSettlementError,
  CommitSettlementInput
>;

export function useCommitSettlement(): UseCommitSettlementReturn {
  const inFlightRef = useRef(false);
  const queryClient = useQueryClient();

  return useMutation<CommitSettlementResult, CommitSettlementError, CommitSettlementInput>({
    mutationFn: async ({
      memberId,
      cycleId,
      expectedPayout,
      password,
    }): Promise<CommitSettlementResult> => {
      if (inFlightRef.current) {
        throw new CommitSettlementError("unknown", "commit already in flight");
      }
      inFlightRef.current = true;
      try {
        const { data, error } = await supabase.functions.invoke<CommitSettlementResult>(
          "cycle-settlement",
          {
            body: {
              member_id: memberId,
              cycle_id: cycleId,
              expected_payout: expectedPayout,
              password,
            },
          },
        );
        if (error) {
          throw await classifyError(error as FunctionsHttpErrorLike);
        }
        if (!data || data.ok !== true || typeof data.settled_payout !== "number") {
          throw new CommitSettlementError("unknown", "Malformed response from cycle-settlement");
        }
        return data;
      } finally {
        inFlightRef.current = false;
      }
    },
    // The settlement flips cycle.status + inserts a transaction → cached
    // profile MUST refetch so the "Clôturer le cycle" CTA disappears.
    onSuccess: (_result, { memberId }) => {
      void queryClient.invalidateQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, memberId] });
    },
  });
}
