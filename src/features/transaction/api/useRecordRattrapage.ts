// Story 4.4 / FR23 — useRecordRattrapage hook.
//
// TanStack mutation wrapping the SECURITY DEFINER record_rattrapage RPC
// (migration 0027). Mirrors useRecordContribution (Story 4.3): in-flight
// ref guard + classifyError + onSuccess invalidates MEMBERS_QUERY_KEY so
// the member moves to the top of the recency-sorted list.
//
// The RPC server-computes amount = dailyAmount × daysCovered — DO NOT
// pass `amount` from the client. Defence-in-depth against tampering.
//
// Closed-cycle gate (sqlstate 23514) is inherited from the BEFORE INSERT
// trigger (Story 3.4) and surfaces as `cycle_closed` here.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";
import { MEMBERS_QUERY_KEY } from "@/features/member";

export type RecordRattrapageErrorCode =
  | "unauthorized"
  | "cycle_closed"
  | "validation"
  | "invalid_days"
  | "not_found"
  | "network"
  | "unknown";

export class RecordRattrapageError extends Error {
  public readonly code: RecordRattrapageErrorCode;
  constructor(code: RecordRattrapageErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RecordRattrapageError";
  }
}

export interface RecordRattrapageInput {
  memberId: string;
  cycleId: string;
  dailyAmount: number;
  cycleDay: number;
  daysCovered: number;
}

function classifyError(
  err: PostgrestError | { message?: string; code?: string } | null,
): RecordRattrapageErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("auth_required") || msg.includes("unauthorized")) return "unauthorized";
  if ("code" in err && err.code === "42501") return "unauthorized";
  // Story 3.4's BEFORE INSERT trigger raises 23514 on closed cycles.
  if ("code" in err && err.code === "23514") {
    // The DB constraint transactions_days_covered_kind_chk also raises
    // 23514 — distinguish via message content.
    if (msg.includes("days_covered") || msg.includes("days_covered_kind")) {
      return "invalid_days";
    }
    return "cycle_closed";
  }
  if (msg.includes("cycle_closed")) return "cycle_closed";
  if (msg.includes("invalid_days_covered")) return "invalid_days";
  if (msg.includes("invalid_amount") || msg.includes("invalid_cycle_day")) return "validation";
  if (msg.includes("not_found")) return "not_found";
  if ("code" in err && (err.code === "P0002" || err.code === "PGRST116")) return "not_found";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

export type UseRecordRattrapageReturn = UseMutationResult<
  string,
  RecordRattrapageError,
  RecordRattrapageInput
>;

export function useRecordRattrapage(): UseRecordRattrapageReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);

  return useMutation<string, RecordRattrapageError, RecordRattrapageInput>({
    mutationFn: async (input): Promise<string> => {
      if (inFlightRef.current) {
        throw new RecordRattrapageError("unknown", "record already in flight");
      }
      inFlightRef.current = true;
      try {
        const { data, error } = await supabase.rpc("record_rattrapage", {
          p_member_id: input.memberId,
          p_cycle_id: input.cycleId,
          p_daily_amount: input.dailyAmount,
          p_cycle_day: input.cycleDay,
          p_days_covered: input.daysCovered,
        });
        if (error) {
          throw new RecordRattrapageError(classifyError(error), error.message);
        }
        if (typeof data !== "string") {
          throw new RecordRattrapageError("unknown", "RPC returned no transaction id");
        }
        return data;
      } finally {
        inFlightRef.current = false;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });
}
