// Story 4.4 / FR23 — useRecordRattrapage hook.
// Story 8.3 — offline-fallback branch + optimistic cache update.
// Story 8.3 code-review patches — shared syntheticTxId + typed offline
// storage error + MEMBER_PROFILE invalidation on online success +
// cancelQueries on both affected keys.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { DASHBOARD_QUERY_KEY } from "@/features/dashboard/api/useDashboardStats";
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

export type RecordRattrapageErrorCode =
  | "unauthorized"
  | "cycle_closed"
  | "validation"
  | "invalid_days"
  | "not_found"
  | "network"
  | "offline_storage"
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

export interface RecordRattrapageResult {
  txId: string;
  wasOffline: boolean;
}

function classifyError(
  err: PostgrestError | { message?: string; code?: string } | null,
): RecordRattrapageErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("auth_required") || msg.includes("unauthorized")) return "unauthorized";
  if ("code" in err && err.code === "42501") return "unauthorized";
  if ("code" in err && err.code === "23514") {
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
  RecordRattrapageResult,
  RecordRattrapageError,
  RecordRattrapageInput,
  OptimisticSnapshots
>;

export function useRecordRattrapage(): UseRecordRattrapageReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);
  const syntheticTxIdRef = useRef<string>("");

  return useMutation<
    RecordRattrapageResult,
    RecordRattrapageError,
    RecordRattrapageInput,
    OptimisticSnapshots
  >({
    // Story 8.3/8.4 — see useRecordContribution: the hook owns offline
    // detection + IndexedDB persistence. Default networkMode 'online'
    // pauses mutationFn while offline, leaving the offline branch dead
    // code. 'always' runs mutationFn regardless of connectivity.
    networkMode: "always",
    mutationFn: async (input): Promise<RecordRattrapageResult> => {
      if (inFlightRef.current) {
        throw new RecordRattrapageError("unknown", "record already in flight");
      }
      inFlightRef.current = true;
      try {
        const syntheticTxId = syntheticTxIdRef.current || crypto.randomUUID();

        if (isOfflineAtEntry()) {
          await persistOfflineEvent(syntheticTxId, input);
          return { txId: syntheticTxId, wasOffline: true };
        }

        try {
          const { data, error } = await supabase.rpc("record_rattrapage", {
            p_member_id: input.memberId,
            p_cycle_id: input.cycleId,
            p_daily_amount: input.dailyAmount,
            p_cycle_day: input.cycleDay,
            p_days_covered: input.daysCovered,
          });
          if (error) {
            const code = classifyError(error);
            if (code === "network") {
              await persistOfflineEvent(syntheticTxId, input);
              return { txId: syntheticTxId, wasOffline: true };
            }
            throw new RecordRattrapageError(code, error.message);
          }
          if (typeof data !== "string") {
            throw new RecordRattrapageError("unknown", "RPC returned no transaction id");
          }
          return { txId: data, wasOffline: false };
        } catch (err) {
          if (err instanceof RecordRattrapageError) throw err;
          if (err instanceof TypeError) {
            await persistOfflineEvent(syntheticTxId, input);
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
        kind: "rattrapage",
        // Optimistic amount = dailyAmount × daysCovered (matches what the
        // RPC server-computes; cache is wiped on reconciler refetch).
        amount: input.dailyAmount * input.daysCovered,
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
        // Story 8.3 patch — invalidate MEMBER_PROFILE_QUERY_KEY too so
        // the optimistic synthetic transaction is replaced by the real
        // server row (was missing in the first pass).
        void queryClient.invalidateQueries({
          queryKey: [...MEMBER_PROFILE_QUERY_KEY, input.memberId],
        });
        // Refresh the dashboard's collected total + recent activity.
        void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
      }
    },
  });
}

async function persistOfflineEvent(
  syntheticTxId: string,
  input: RecordRattrapageInput,
): Promise<void> {
  const collectorId = await getCurrentCollectorId();
  if (!collectorId) {
    throw new RecordRattrapageError(
      "unauthorized",
      "no active session — cannot queue offline event",
    );
  }
  const event = buildOfflineEvent({
    syntheticTxId,
    collectorId,
    mutation: { kind: "rattrapage", input },
  });
  try {
    await appendEvent(event);
  } catch (err) {
    if (err instanceof OfflineEventLogError) {
      throw new RecordRattrapageError(
        "offline_storage",
        `failed to queue offline event (${err.code}): ${err.message}`,
      );
    }
    throw err;
  }
}
