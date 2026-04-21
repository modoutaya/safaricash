// Story 1.7 — requestSignOut: unified entry point for sign-out.
//
// Both the explicit user-tapped "Se déconnecter" action AND the Story 1.6
// idle-timeout expiry go through this helper, which:
//   1. Sets signOutStateRef.reason so AuthStateListener picks the right
//      toast (explicit → "Vous êtes déconnecté"; idle → "Session expirée").
//   2. Best-effort emits the session.signed_out audit event (2 s timeout;
//      a slow or unreachable server MUST NOT block sign-out UX).
//   3. Calls purgeSessionData() (placeholder for Story 8.3 IndexedDB purge).
//   4. Calls supabase.auth.signOut({ scope: "local" }) — local scope so a
//      collector signing out of a shared device keeps their other sessions.
//   5. Returns void and never throws: Supabase-js clears localStorage even
//      when signOut rejects, so the user IS signed out on the client
//      regardless; rethrowing would create confusing UX.

import { supabase } from "@/infrastructure/supabase/client";

export type SignOutReason = "explicit" | "idle";

/**
 * Module-scoped flag read by `AuthStateListener` inside its SIGNED_OUT
 * handler to choose the right toast. Pattern consistent with Story 1.5's
 * `hadSessionRef` — a ref outlives the async signOut → SIGNED_OUT chain.
 *
 * Exposed as an object with a mutable property (not a bare `let`) so
 * consumers can import the reference and read the latest value without
 * re-importing. Cleared by the listener after it reads the reason.
 */
export const signOutStateRef: { reason: SignOutReason | null } = { reason: null };

const AUDIT_EMIT_TIMEOUT_MS = 2_000;

/**
 * Placeholder for Story 8.3's IndexedDB offline-outbox purge.
 *
 * At Story 1.7 implementation time SafariCash has no IndexedDB code — the
 * PWA persists nothing to IndexedDB yet. Story 8.2 introduces the event
 * log; Story 8.3 adds the outbox. At that point this function will be
 * filled in to drop those stores on sign-out so a next user on the same
 * device does not inherit queued writes from the previous collector.
 *
 * The function returns a resolved promise today so `requestSignOut` can
 * `await` it unconditionally — the call site stays stable across the
 * Story 8.x landing.
 */
export async function purgeSessionData(): Promise<void> {
  // TODO(Story 8.3): purge IndexedDB outbox + event log.
  return Promise.resolve();
}

/**
 * Sign the current collector out. Explicit callers pass `"explicit"`;
 * Story 1.6's idle-timeout hook passes `"idle"`.
 *
 * - Sets `signOutStateRef.reason` synchronously BEFORE awaiting anything,
 *   so even if signOut fires SIGNED_OUT before this function returns,
 *   the listener sees the correct reason.
 * - Audit emission runs with a 2 s budget — a hung RPC cannot stall
 *   sign-out. A dropped audit row is recoverable via ops reconciliation;
 *   a stuck UI is not.
 * - Never throws. `signOut()` rejection is logged (DEV only) because
 *   Supabase-js already cleared local session state — the user IS signed
 *   out on the client regardless of network outcome.
 */
export async function requestSignOut(reason: SignOutReason): Promise<void> {
  signOutStateRef.reason = reason;

  // Best-effort audit emit. Promise.race against a timeout so a slow
  // network cannot block sign-out. All error paths (RPC rejection,
  // timeout, non-200) collapse to a silent DEV warn — the sign-out MUST
  // proceed regardless.
  try {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("audit emit timeout")),
        AUDIT_EMIT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([supabase.rpc("emit_session_event", { p_reason: reason }), timeout]);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[signOut] audit emit failed", err);
    }
  }

  // IndexedDB purge (placeholder — Story 8.3 fills the body).
  await purgeSessionData();

  // Local scope ONLY. A collector may be signed in on a personal phone AND
  // a shared office device; signing out of the shared device MUST NOT
  // invalidate the personal-phone session. See story spec AC #3.
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[signOut] supabase.auth.signOut rejected (local state still cleared)", err);
    }
  }
}
