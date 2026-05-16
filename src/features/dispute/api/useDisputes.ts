// Story 10.3 — useDisputes(memberId): the member's OPEN disputes.
//
// `disputes` has no member_id column — it links via transaction_id →
// transactions.member_id. A PostgREST embedded inner-join filter
// (`transactions!inner(member_id)` + `.eq("transactions.member_id", …)`)
// scopes the query to the member. RLS (disputes_collector_isolation /
// transactions own-rows) keeps it collector-isolated transitively.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import { supabase } from "@/infrastructure/supabase/client";

import { DISPUTES_QUERY_KEY, disputeRowSchema, type DisputeRow } from "../types";

const disputesResponseSchema = z.array(disputeRowSchema);

export async function fetchOpenDisputes(memberId: string): Promise<DisputeRow[]> {
  const { data, error } = await supabase
    .from("disputes")
    .select("id, transaction_id, notes, flagged_at, status, transactions!inner(member_id)")
    .eq("transactions.member_id", memberId)
    .eq("status", "open");
  if (error) {
    throw new Error(`disputes query failed: ${error.message}`);
  }
  // disputeRowSchema is a non-strict object — the embedded `transactions`
  // join key is dropped on parse.
  return disputesResponseSchema.parse(data ?? []);
}

export function useDisputes(memberId: string | undefined): UseQueryResult<DisputeRow[], Error> {
  return useQuery({
    queryKey: [...DISPUTES_QUERY_KEY, "member", memberId],
    queryFn: () => fetchOpenDisputes(memberId!),
    enabled: !!memberId,
    staleTime: 30_000,
  });
}
