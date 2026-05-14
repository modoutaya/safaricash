// Story 5.4 / FR24 + FR25 — useRecordAdvance hook.
// Story 8.3 — offline-fallback branch + optimistic cache update.
// Story 8.3 code-review patches — shared syntheticTxId + typed offline
// storage error + cancelQueries on both affected keys.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { MEMBERS_QUERY_KEY, MEMBER_PROFILE_QUERY_KEY } from "@/features/member";
import { supabase } from "@/infrastructure/supabase/client";
import { appendEvent, OfflineEventLogError } from "@/infrastructure/sync";

import { buildOfflineEvent } from "./buildOfflineEvent";
import { getCurrentCollectorId, isOfflineAtEntry } from "./offlineGuards";
import {
  applyOptimisticTransactionUpdate,
  cancelOptimisticQueries,
  rollbackOptimisticTransactionUpdate,
  type OptimisticSnapshots,
} from "./optimisticCache";
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
  | "offline_storage"
  | "unknown";

export class RecordAdvanceError extends Error {
  public readonly code: RecordAdvanceErrorCode;
  constructor(code: RecordAdvanceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RecordAdvanceError";
  }
}

export interface RecordAdvanceResult {
  txId: string;
  wasOffline: boolean;
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
  RecordAdvanceResult,
  RecordAdvanceError,
  RecordAdvanceInput,
  OptimisticSnapshots
>;

export function useRecordAdvance(): UseRecordAdvanceReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);
  const syntheticTxIdRef = useRef<string>("");

  return useMutation<
    RecordAdvanceResult,
    RecordAdvanceError,
    RecordAdvanceInput,
    OptimisticSnapshots
  >({
    mutationFn: async (input): Promise<RecordAdvanceResult> => {
      if (inFlightRef.current) {
        throw new RecordAdvanceError("unknown", "record already in flight");
      }
      inFlightRef.current = true;
      try {
        // Zod boundary validation — runs even on the offline branch so
        // bad input never reaches the IDB log.
        const parsed = RecordAdvanceInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new RecordAdvanceError("validation", parsed.error.message);
        }
        const safeInput = parsed.data;
        const syntheticTxId = syntheticTxIdRef.current || crypto.randomUUID();

        if (isOfflineAtEntry()) {
          await persistOfflineEvent(syntheticTxId, safeInput);
          return { txId: syntheticTxId, wasOffline: true };
        }

        try {
          const { data, error } = await supabase.rpc("record_advance", {
            p_member_id: safeInput.memberId,
            p_cycle_id: safeInput.cycleId,
            p_amount: safeInput.amount,
            p_cycle_day: safeInput.cycleDay,
            p_motive: safeInput.motive,
            p_saver_acknowledged: safeInput.saverAcknowledged,
          });
          if (error) {
            const code = classifyError(error);
            if (code === "network") {
              await persistOfflineEvent(syntheticTxId, safeInput);
              return { txId: syntheticTxId, wasOffline: true };
            }
            throw new RecordAdvanceError(code, error.message);
          }
          if (typeof data !== "string") {
            throw new RecordAdvanceError("unknown", "RPC returned no transaction id");
          }
          return { txId: data, wasOffline: false };
        } catch (err) {
          if (err instanceof RecordAdvanceError) throw err;
          if (err instanceof TypeError) {
            await persistOfflineEvent(syntheticTxId, safeInput);
            return { txId: syntheticTxId, wasOffline: true };
          }
          throw err;
        }
      } finally {
        inFlightRef.current = false;
      }
    },

    onMutate: async (input): Promise<OptimisticSnapshots> => {
      const syntheticTxId = crypto.randomUUID();
      syntheticTxIdRef.current = syntheticTxId;
      await cancelOptimisticQueries(queryClient, input.memberId);
      return applyOptimisticTransactionUpdate(queryClient, {
        memberId: input.memberId,
        cycleId: input.cycleId,
        syntheticTxId,
        kind: "advance",
        amount: input.amount,
        cycleDay: input.cycleDay,
      });
    },

    onError: (_err, input, context) => {
      if (context) {
        rollbackOptimisticTransactionUpdate(queryClient, input.memberId, context);
      }
    },

    onSuccess: (result, input) => {
      if (!result.wasOffline) {
        void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
        void queryClient.invalidateQueries({
          queryKey: [...MEMBER_PROFILE_QUERY_KEY, input.memberId],
        });
      }
    },
  });
}

async function persistOfflineEvent(
  syntheticTxId: string,
  input: RecordAdvanceInput,
): Promise<void> {
  const collectorId = await getCurrentCollectorId();
  if (!collectorId) {
    throw new RecordAdvanceError("unauthorized", "no active session — cannot queue offline event");
  }
  const event = buildOfflineEvent({
    syntheticTxId,
    collectorId,
    mutation: { kind: "advance", input },
  });
  try {
    await appendEvent(event);
  } catch (err) {
    if (err instanceof OfflineEventLogError) {
      throw new RecordAdvanceError(
        "offline_storage",
        `failed to queue offline event (${err.code}): ${err.message}`,
      );
    }
    throw err;
  }
}
