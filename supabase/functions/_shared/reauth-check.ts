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
 *   - clock_timestamp() < confirmation_expires_at  (DB clock — CODE REVIEW H8 fix)
 *
 * Returns ok:true on success; ok:false with a generic problem otherwise.
 *
 * Delegates to the SECURITY DEFINER RPC `public.reauth_consume_confirmation`
 * (migration 0008) so the expiry check uses Postgres `clock_timestamp()`
 * instead of the JS `new Date()` clock — eliminates a clock-skew bypass
 * where an Edge Function instance lagging behind the DB by seconds could
 * accept already-expired tokens (or reject still-valid ones).
 *
 * MUST be called with a service-role Supabase client — the RPC is REVOKE'd
 * from authenticated/anon.
 */
export async function consumeConfirmation(
  supabase: SupabaseClient,
  collectorId: string,
  intendedOp: IntendedOp,
  confirmationToken: string,
): Promise<ConsumeResult> {
  const { data, error } = await supabase.rpc("reauth_consume_confirmation", {
    p_token: confirmationToken,
    p_collector_id: collectorId,
    p_intended_op: intendedOp,
  });

  if (error) {
    return {
      ok: false,
      problem: problem("internal_unexpected", `consumeConfirmation: ${error.message}`),
    };
  }
  if (data !== true) {
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
