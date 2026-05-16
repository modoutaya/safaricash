// Story 10.3 — useResolveDispute: the "Marquer comme résolue" mutation.
//
// A direct RLS-scoped PostgREST UPDATE on `disputes` (status open →
// resolved). disputes_collector_isolation is FOR ALL with
// `collector_id = auth.uid()`, so the collector may update their own
// dispute rows directly — no SECURITY DEFINER RPC. The audit_disputes
// trigger (Story 10.3 migration — AFTER INSERT OR UPDATE) hash-chains a
// `dispute.resolved` event. On success the member's disputes query is
// invalidated so the banner + the row icon clear (the member-profile
// query is unaffected — disputes never alter member/cycle/transaction
// data, so invalidating it would be pointless churn).

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { supabase } from "@/infrastructure/supabase/client";

import { DISPUTES_QUERY_KEY } from "../types";

export function useResolveDispute(memberId: string): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (disputeId: string) => {
      // Guard on `status = 'open'`: a no-op UPDATE on an already-resolved
      // dispute would overwrite resolved_at AND chain a spurious
      // `dispute.updated` audit event. `.select("id")` lets us detect the
      // zero-rows case and surface it as an error (the sheet stays open).
      const { data, error } = await supabase
        .from("disputes")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("id", disputeId)
        .eq("status", "open")
        .select("id");
      if (error) {
        throw new Error(`resolve dispute failed: ${error.message}`);
      }
      if (!data || data.length === 0) {
        throw new Error("resolve dispute failed: dispute is not open");
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...DISPUTES_QUERY_KEY, "member", memberId],
      });
    },
    // Default networkMode 'online' PAUSES the mutationFn while offline,
    // hanging the resolve button with no error toast. 'always' fires
    // immediately so the failure surfaces — matches the sibling
    // transaction/member mutations.
    networkMode: "always",
  });
}
