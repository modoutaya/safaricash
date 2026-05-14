// Story 4.3 — useRecordContribution hook.
// Story 8.3 — offline-fallback branch + optimistic cache update.
// Story 8.3 code-review patches — shared syntheticTxId between onMutate
// and mutationFn (UUID lockstep), typed offline-storage error path,
// MEMBER_PROFILE_QUERY_KEY invalidation on online success.

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

export type RecordContributionErrorCode =
  | "unauthorized"
  | "cycle_closed"
  | "validation"
  | "not_found"
  | "network"
  | "offline_storage"
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

export interface RecordContributionResult {
  txId: string;
  wasOffline: boolean;
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
  RecordContributionResult,
  RecordContributionError,
  RecordContributionInput,
  OptimisticSnapshots
>;

export function useRecordContribution(): UseRecordContributionReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);
  // Shared between onMutate (which writes the cache row) and mutationFn
  // (which writes the IDB event log + returns the txId). Story 8.3
  // code-review fix: two independent crypto.randomUUID() calls produced
  // mismatched IDs; the ref keeps them in lockstep.
  const syntheticTxIdRef = useRef<string>("");

  return useMutation<
    RecordContributionResult,
    RecordContributionError,
    RecordContributionInput,
    OptimisticSnapshots
  >({
    mutationFn: async (input): Promise<RecordContributionResult> => {
      if (inFlightRef.current) {
        throw new RecordContributionError("unknown", "record already in flight");
      }
      inFlightRef.current = true;
      try {
        // Use the UUID that onMutate generated; falls back to a fresh
        // one only if onMutate was somehow skipped (e.g. mutationFn
        // called directly from a test).
        const syntheticTxId = syntheticTxIdRef.current || crypto.randomUUID();

        if (isOfflineAtEntry()) {
          await persistOfflineEvent(syntheticTxId, input);
          return { txId: syntheticTxId, wasOffline: true };
        }

        try {
          const { data, error } = await supabase.rpc("record_contribution", {
            p_member_id: input.memberId,
            p_cycle_id: input.cycleId,
            p_amount: input.amount,
            p_cycle_day: input.cycleDay,
          });
          if (error) {
            const code = classifyError(error);
            if (code === "network") {
              await persistOfflineEvent(syntheticTxId, input);
              return { txId: syntheticTxId, wasOffline: true };
            }
            throw new RecordContributionError(code, error.message);
          }
          if (typeof data !== "string") {
            throw new RecordContributionError("unknown", "RPC returned no transaction id");
          }
          return { txId: data, wasOffline: false };
        } catch (err) {
          if (err instanceof RecordContributionError) throw err;
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
      // Generate the shared synthetic ID FIRST so mutationFn can read
      // it via the ref. onMutate always runs before mutationFn per
      // TanStack Query's mutation lifecycle.
      const syntheticTxId = crypto.randomUUID();
      syntheticTxIdRef.current = syntheticTxId;

      // Cancel BOTH affected query keys (Story 8.3 patch — was missing
      // the profile-key cancel, which allowed a race on refetch).
      await cancelOptimisticQueries(queryClient, input.memberId);

      return applyOptimisticTransactionUpdate(queryClient, {
        memberId: input.memberId,
        cycleId: input.cycleId,
        syntheticTxId,
        kind: "contribution",
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
      // Skip invalidation on the offline branch — the server doesn't yet
      // know about the event; a refetch would wipe the optimistic snapshot.
      // Story 8.4's reconciler will trigger the invalidation on successful
      // replay.
      if (!result.wasOffline) {
        void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
        // Story 8.3 patch — also invalidate the affected member's
        // profile so the optimistic synthetic transaction is replaced
        // by the real server row. Without this, the profile shows
        // duplicate (real + synthetic) rows for up to staleTime (30s).
        void queryClient.invalidateQueries({
          queryKey: [...MEMBER_PROFILE_QUERY_KEY, input.memberId],
        });
      }
    },
  });
}

async function persistOfflineEvent(
  syntheticTxId: string,
  input: RecordContributionInput,
): Promise<void> {
  const collectorId = await getCurrentCollectorId();
  if (!collectorId) {
    throw new RecordContributionError(
      "unauthorized",
      "no active session — cannot queue offline event",
    );
  }
  const event = buildOfflineEvent({
    syntheticTxId,
    collectorId,
    mutation: { kind: "contribution", input },
  });
  try {
    await appendEvent(event);
  } catch (err) {
    if (err instanceof OfflineEventLogError) {
      // Wrap into a typed Record*Error so consumers route to the right
      // toast copy. Without this, OfflineEventLogError propagated as an
      // un-classified exception and MemberList's catch{} swallowed it
      // silently — the user lost their transaction with no feedback.
      throw new RecordContributionError(
        "offline_storage",
        `failed to queue offline event (${err.code}): ${err.message}`,
      );
    }
    throw err;
  }
}
