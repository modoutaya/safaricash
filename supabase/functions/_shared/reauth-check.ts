// Consumer-facing helper. Story 7.4 (cycle-settlement), 2.6 (member-delete
// edge function if any), 9.3 (csv-export), 6.x (sms-resend) call this
// before committing the sensitive operation.
//
// The single atomic UPDATE-RETURNING ensures the confirmation token is
// consumed exactly once. All failure modes return the same generic
// 'confirmation/invalid' problem — distinguishing them would leak whether
// a token exists for someone else.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { problem, type Problem } from "./rfc7807.ts";

export type IntendedOp = "cycle_settlement" | "member_delete" | "csv_export" | "sms_resend";

export type ConsumeResult = { ok: true } | { ok: false; problem: Problem };

/**
 * Atomically marks the confirmation_token as consumed iff:
 *   - the token exists
 *   - the row's collector_id matches `collectorId`
 *   - the row's intended_op matches `intendedOp`
 *   - confirmation_used is false
 *   - now() < confirmation_expires_at
 *
 * Returns ok:true on success; ok:false with a generic problem otherwise.
 *
 * MUST be called with a service-role Supabase client — RLS would otherwise
 * gate the UPDATE.
 */
export async function consumeConfirmation(
  supabase: SupabaseClient,
  collectorId: string,
  intendedOp: IntendedOp,
  confirmationToken: string,
): Promise<ConsumeResult> {
  // Single statement, atomic on the row. Returns the id if all conditions
  // matched and the row was updated; null otherwise.
  const { data, error } = await supabase
    .from("reauth_challenges")
    .update({ confirmation_used: true })
    .eq("confirmation_token", confirmationToken)
    .eq("collector_id", collectorId)
    .eq("intended_op", intendedOp)
    .eq("confirmation_used", false)
    .gt("confirmation_expires_at", new Date().toISOString())
    .select("id")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      problem: problem("internal_unexpected", `consumeConfirmation: ${error.message}`),
    };
  }
  if (!data) {
    return {
      ok: false,
      problem: problem(
        "confirmation_invalid",
        "Confirmation token invalid, expired, already used, or wrong scope",
      ),
    };
  }
  return { ok: true };
}
