// Story 5.4 / FR24 + FR25 — useRecordAdvance hook.
//
// TanStack mutation wrapping the SECURITY DEFINER record_advance RPC
// (migration 0033). Mirrors useRecordContribution / useRecordRattrapage:
// in-flight ref guard + classifyError + onSuccess invalidates
// MEMBERS_QUERY_KEY (recency sort) AND MEMBER_PROFILE_QUERY_KEY (cycle
// status flips active → with_advance).
//
// Pre-call Zod validation via RecordAdvanceInputSchema — defence-in-depth
// on top of the client gate (Story 5.3) and the RPC + DB CHECK.
//
// Error codes mirror the RPC's sqlstates + a couple of client-side cases:
//   - unauthorized        ← 28000, 42501
//   - cycle_closed        ← 23514 from Story 3.4 BEFORE INSERT trigger
//   - over_limit          ← 22023 from RPC capacity check
//   - invalid_motive      ← 22000 + message contains "motive"
//   - missing_acknowledgment ← 22000 + message contains "acknowledgment"
//   - validation          ← 22000 (other) OR Zod rejection
//   - not_found           ← P0002, PGRST116
//   - network             ← message contains fetch/network
//   - unknown             ← fallback

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";
import { MEMBERS_QUERY_KEY, MEMBER_PROFILE_QUERY_KEY } from "@/features/member";

import { RecordAdvanceInputSchema, type RecordAdvanceInput } from "./RecordAdvanceInputSchema";

export type RecordAdvanceErrorCode =
  | "unauthorized"
  | "cycle_closed"
  | "over_limit"
  | "invalid_motive"
  | "missing_acknowledgment"
  | "validation"
  | "not_found"
  | "network"
  | "unknown";

export class RecordAdvanceError extends Error {
  public readonly code: RecordAdvanceErrorCode;
  constructor(code: RecordAdvanceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RecordAdvanceError";
  }
}

function classifyError(
  err: PostgrestError | { message?: string; code?: string } | null,
): RecordAdvanceErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  const code = "code" in err ? err.code : undefined;

  if (msg.includes("auth_required") || msg.includes("unauthorized")) return "unauthorized";
  if (code === "42501" || code === "28000") return "unauthorized";
  if (code === "23514") return "cycle_closed";
  if (msg.includes("cycle_closed")) return "cycle_closed";
  if (code === "22023" || msg.includes("over_limit")) return "over_limit";
  if (msg.includes("invalid_motive")) return "invalid_motive";
  if (msg.includes("missing_acknowledgment")) return "missing_acknowledgment";
  if (msg.includes("invalid_amount") || msg.includes("invalid_cycle_day")) return "validation";
  if (code === "22000") return "validation";
  if (code === "P0002" || code === "PGRST116") return "not_found";
  if (msg.includes("not_found")) return "not_found";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

export type UseRecordAdvanceReturn = UseMutationResult<
  string,
  RecordAdvanceError,
  RecordAdvanceInput
>;

export function useRecordAdvance(): UseRecordAdvanceReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);

  return useMutation<string, RecordAdvanceError, RecordAdvanceInput>({
    mutationFn: async (input): Promise<string> => {
      if (inFlightRef.current) {
        throw new RecordAdvanceError("unknown", "record already in flight");
      }
      inFlightRef.current = true;
      try {
        // Zod boundary validation.
        const parsed = RecordAdvanceInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new RecordAdvanceError("validation", parsed.error.message);
        }
        const safeInput = parsed.data;

        const { data, error } = await supabase.rpc("record_advance", {
          p_member_id: safeInput.memberId,
          p_cycle_id: safeInput.cycleId,
          p_amount: safeInput.amount,
          p_cycle_day: safeInput.cycleDay,
          p_motive: safeInput.motive,
          p_saver_acknowledged: safeInput.saverAcknowledged,
        });
        if (error) {
          throw new RecordAdvanceError(classifyError(error), error.message);
        }
        if (typeof data !== "string") {
          throw new RecordAdvanceError("unknown", "RPC returned no transaction id");
        }
        return data;
      } finally {
        inFlightRef.current = false;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MEMBER_PROFILE_QUERY_KEY });
    },
  });
}
