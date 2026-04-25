// Story 4.3 — useRecordContribution hook.
//
// TanStack mutation wrapping the SECURITY DEFINER record_contribution RPC
// (migration 0023). Mirrors useUpdateMember (Story 2.5) shape: in-flight
// ref guard + classifyError + onSuccess invalidates MEMBERS_QUERY_KEY so
// the member moves to the top of the recency-sorted list.
//
// Cycle-closed gate (sqlstate 23514) is inherited from the BEFORE INSERT
// trigger (Story 3.4) and surfaces as `cycle_closed` here.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";
import { MEMBERS_QUERY_KEY } from "@/features/member";

export type RecordContributionErrorCode =
  | "unauthorized"
  | "cycle_closed"
  | "validation"
  | "not_found"
  | "network"
  | "unknown";

export class RecordContributionError extends Error {
  public readonly code: RecordContributionErrorCode;
  constructor(code: RecordContributionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RecordContributionError";
  }
}

export interface RecordContributionInput {
  memberId: string;
  cycleId: string;
  amount: number;
  cycleDay: number;
}

function classifyError(
  err: PostgrestError | { message?: string } | null,
): RecordContributionErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("auth_required") || msg.includes("unauthorized")) return "unauthorized";
  if ("code" in err && err.code === "42501") return "unauthorized";
  // Story 3.4's BEFORE INSERT trigger raises 23514 on closed cycles.
  if ("code" in err && err.code === "23514") return "cycle_closed";
  if (msg.includes("cycle_closed")) return "cycle_closed";
  if (msg.includes("invalid_amount") || msg.includes("invalid_cycle_day")) return "validation";
  if (msg.includes("not_found")) return "not_found";
  if ("code" in err && (err.code === "P0002" || err.code === "PGRST116")) return "not_found";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

export type UseRecordContributionReturn = UseMutationResult<
  string,
  RecordContributionError,
  RecordContributionInput
>;

export function useRecordContribution(): UseRecordContributionReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);

  return useMutation<string, RecordContributionError, RecordContributionInput>({
    mutationFn: async (input): Promise<string> => {
      if (inFlightRef.current) {
        throw new RecordContributionError("unknown", "record already in flight");
      }
      inFlightRef.current = true;
      try {
        const { data, error } = await supabase.rpc("record_contribution", {
          p_member_id: input.memberId,
          p_cycle_id: input.cycleId,
          p_amount: input.amount,
          p_cycle_day: input.cycleDay,
        });
        if (error) {
          throw new RecordContributionError(classifyError(error), error.message);
        }
        if (typeof data !== "string") {
          throw new RecordContributionError("unknown", "RPC returned no transaction id");
        }
        return data;
      } finally {
        inFlightRef.current = false;
      }
    },
    onSuccess: () => {
      // Member moves to the top of the list (recency sort) — invalidate.
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });
}
