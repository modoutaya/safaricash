// Story 8.3 / FR40 — useCollectorId hook.
//
// Returns the current session's user id (the collector_id, since
// `auth.uid()` IS the collector_id per the schema). Session-aware:
// re-renders on SIGNED_IN / INITIAL_SESSION / SIGNED_OUT so consumers
// (notably useConnectivityState, which partitions countEvents by the
// current collector) react to auth changes without remounting.
//
// Initial render returns `null` (the getSession() probe is async).
// Once the session resolves OR INITIAL_SESSION fires, the hook updates
// to the user's id. On sign-out, it falls back to `null`.

import { useEffect, useState } from "react";

import { supabase } from "@/infrastructure/supabase/client";

export function useCollectorId(): string | null {
  const [collectorId, setCollectorId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Initial probe. Resolves the persisted-session collector id on cold
    // load BEFORE onAuthStateChange has a chance to fire (the listener
    // does emit INITIAL_SESSION but the timing is implementation-defined
    // — getSession() is the canonical synchronous-ish read).
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setCollectorId(data.session?.user.id ?? null);
      })
      .catch(() => {
        // Safari private mode + storage throttling can reject getSession.
        // The onAuthStateChange subscription below drives state as a
        // fallback (INITIAL_SESSION fires regardless).
      });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") {
        setCollectorId(session?.user.id ?? null);
      } else if (event === "SIGNED_OUT") {
        setCollectorId(null);
      }
      // Other events (USER_UPDATED, PASSWORD_RECOVERY, MFA_CHALLENGE_VERIFIED)
      // don't change collector identity at MVP — ignore.
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  return collectorId;
}
