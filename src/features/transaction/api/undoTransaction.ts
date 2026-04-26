// Story 4.5 — undoTransaction soft-undo helper.
//
// REWRITES Story 4.3's hard-DELETE path. The undo_transaction RPC
// (migration 0029) sets transactions.undone_at = now(), cancels any
// queued sms_queue row, and emits a typed transaction.undone audit
// event (via the audit_emit patch in migration 0030).
//
// transactions_decrypted view filters undone rows (migration 0031);
// useMembers query also filters .is("undone_at", null) so the recency
// sort doesn't surface the just-undone member.
//
// Errors come back as a typed UndoTransactionError; consumers (e.g.,
// MemberList onUndo wrapper) map them to i18n toast copy.

import type { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/infrastructure/supabase/client";
import { MEMBERS_QUERY_KEY, MEMBER_PROFILE_QUERY_KEY } from "@/features/member";

import { UndoTransactionError, classifyUndoError } from "./undoTransactionError";

export async function undoTransaction(
  transactionId: string,
  queryClient: QueryClient,
): Promise<void> {
  const { error } = await supabase.rpc("undo_transaction", {
    p_transaction_id: transactionId,
  });
  if (error) {
    throw new UndoTransactionError(classifyUndoError(error), error.message);
  }
  // Recency sort regresses — invalidate the member list AND the per-
  // member profile (transaction history will lose the undone row).
  void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: MEMBER_PROFILE_QUERY_KEY });
}
