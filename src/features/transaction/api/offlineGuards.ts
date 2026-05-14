// Story 8.3 — shared offline-fallback guards for the 3 record-* hooks.
//
// Centralises (a) the navigator.onLine short-circuit predicate and
// (b) the supabase session collectorId lookup so the same logic isn't
// copy-pasted across useRecordContribution / useRecordAdvance /
// useRecordRattrapage. Future auth or platform changes touch one file.

import { supabase } from "@/infrastructure/supabase/client";

/** Whether the caller is OFFLINE at mutation entry. Used as the
 *  fast-path short-circuit before the RPC attempt. */
export function isOfflineAtEntry(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.onLine === false;
}

/** Resolve the current session's collector id (auth.uid). Returns null
 *  when no active session OR when getSession rejects (Safari private
 *  mode + storage throttling). Callers must short-circuit to an
 *  `unauthorized` error in the null case rather than appending an
 *  orphan event without a partition key. */
export async function getCurrentCollectorId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}
