// Story 4.3 — undoTransaction helper.
//
// Direct DELETE via PostgREST (RLS allows authenticated DELETE on own
// transactions per migration 0002). The audit chain captures both the
// transaction.committed event from the original INSERT AND the
// transaction.deleted event from this DELETE — internally consistent.
//
// sms_queue rows cascade via FK on delete cascade (migration 0001:159),
// so no cleanup needed here.

import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/infrastructure/supabase/client";
import { MEMBERS_QUERY_KEY } from "@/features/member";

export async function undoTransaction(
  transactionId: string,
  queryClient: QueryClient,
): Promise<void> {
  const { error } = await supabase.from("transactions").delete().eq("id", transactionId);
  if (error) {
    throw new Error(`undoTransaction failed: ${error.message}`);
  }
  // Recency sort regresses — invalidate the member list.
  void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
}
