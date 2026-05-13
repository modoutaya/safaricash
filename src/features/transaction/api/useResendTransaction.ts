// Story 6.7 — useResendTransaction mutation hook.
//
// Direct RPC call (NO Edge Function). The Story 6.6 review confirmed that
// re-auth is intentionally NOT required for per-transaction resend (FR5
// only covers full-cycle resends). The RPC enforces ownership + opt-out +
// undone + kind gates server-side and returns (enqueued, reason).

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { supabase } from "@/infrastructure/supabase/client";
import { MEMBER_PROFILE_QUERY_KEY } from "@/features/member";

import { ResendTransactionError, type ResendTransactionErrorCode } from "./resendTransactionError";

export type ResendTransactionReason = "opt_out" | "no_phone" | "undone" | "unsupported_kind" | null;

export interface ResendTransactionResult {
  enqueued: number;
  reason: ResendTransactionReason;
}

export interface ResendTransactionInput {
  transactionId: string;
  /** Optional — passed through to onSuccess for cache invalidation scoped
   *  to a specific member's profile query. */
  memberId?: string;
}

function classifyPostgrestError(err: {
  code?: string;
  message?: string;
}): ResendTransactionErrorCode {
  if (err.code === "28000") return "auth_unauthenticated";
  if (err.code === "P0002") return "not_found";
  // 5xx / unknown PG errors.
  if (err.code && err.code.length > 0) return "internal_unexpected";
  return "unknown";
}

export type UseResendTransactionReturn = UseMutationResult<
  ResendTransactionResult,
  ResendTransactionError,
  ResendTransactionInput
>;

export function useResendTransaction(): UseResendTransactionReturn {
  const queryClient = useQueryClient();

  return useMutation<ResendTransactionResult, ResendTransactionError, ResendTransactionInput>({
    mutationFn: async ({ transactionId }): Promise<ResendTransactionResult> => {
      let data: unknown;
      let error: { code?: string; message?: string } | null;
      try {
        // The generated database.types.ts in this checkout pre-dates the
        // migration 0055 RPC. Cast the CLIENT (not the method) — extracting
        // `supabase.rpc` as a free reference loses `this`, and the internal
        // `this.rest` access throws "Cannot read properties of undefined
        // (reading 'rest')" at runtime (CI Playwright run 25784303955 caught
        // this). Calling via `client.rpc(...)` keeps the binding intact.
        // Behaviour is unaffected — supabase-js dispatches by string name
        // at runtime regardless of TS typing.
        const client = supabase as unknown as {
          rpc: (
            fn: string,
            args: Record<string, unknown>,
          ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
        };
        const res = await client.rpc("enqueue_resend_transaction", {
          p_transaction_id: transactionId,
        });
        data = res.data;
        error = res.error;
      } catch (err) {
        // supabase.rpc surfaces network failures as a raw TypeError (fetch
        // reject). The FunctionsFetchError name belongs to the Edge Functions
        // client path, not the PostgREST/RPC path, so we don't check for it
        // here — see code review patch P8 (Story 6.7) for context.
        if (err instanceof TypeError) {
          throw new ResendTransactionError("network", err.message);
        }
        throw new ResendTransactionError("unknown", (err as Error).message);
      }

      if (error) {
        const code = classifyPostgrestError(error);
        throw new ResendTransactionError(code, error.message ?? "RPC failed");
      }

      // RPC returns a one-element array (table-returning function).
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof (row as { enqueued?: unknown }).enqueued !== "number") {
        throw new ResendTransactionError("unknown", "Malformed RPC response");
      }
      return {
        enqueued: (row as { enqueued: number }).enqueued,
        reason: (row as { reason?: ResendTransactionReason }).reason ?? null,
      };
    },
    // Invalidate the member's profile (which backs the transaction list) on
    // success so future per-transaction status indicators see fresh sms_queue
    // state. Mirrors the Story 6.6 code-review patch.
    onSuccess: (result, { memberId }) => {
      if (result.enqueued > 0 && memberId) {
        void queryClient.invalidateQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, memberId] });
      }
    },
  });
}
