// Story 1.5 — Global providers + auth state listener.
//
// This module splits two concerns:
//   1. <RootProviders>  — TanStack Query + Sonner <Toaster>. Mounted at the
//      tree root by main.tsx, OUTSIDE the router so it can host toast
//      surfaces visible on public routes (e.g. /login's error banner uses
//      inline copy today, but a future toast API would work too).
//   2. <AuthStateListener> — subscribes to supabase.auth.onAuthStateChange
//      and redirects to /login on SIGNED_OUT. Mounted INSIDE the router via
//      the root route element so `useNavigate()` is available.
//
// Story 1.6's idle-timeout (NFR-S4 30 min) triggers a SIGNED_OUT event,
// which this listener catches — so the routing plumbing for 1.6 is in
// place without 1.6 needing to touch this file.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { toast, Toaster } from "sonner";

import { requestSignOut, signOutStateRef } from "@/features/auth/api/signOut";
import { useIdleTimeout } from "@/features/auth/api/useIdleTimeout";
import { supabase } from "@/infrastructure/supabase/client";
import { useT } from "@/i18n/useT";
import { SESSION_ABSOLUTE_LIFETIME_MS, SESSION_IDLE_TIMEOUT_MS } from "@/lib/constants";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 3,
    },
  },
});

// Story 8.6 — offline read path. The member list / search / profile must
// survive a cold app reload while offline, so the member query cache is
// persisted to localStorage and rehydrated on boot. Only `members` queries
// are persisted (the dehydrate filter below) — transaction / SMS / cycle
// queries are volatile and stay in-memory.
const PERSIST_CACHE_KEY = "safaricash:query-cache";
// NFR-R2 — 24 h offline tolerance; persisted data older than this is dropped.
const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Bump when the persisted member-query shape changes so stale structures
// are discarded rather than mis-hydrated.
const PERSIST_BUSTER = "8.6-members-v1";

export const queryPersister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: PERSIST_CACHE_KEY,
});

/** Persist ONLY successful member queries (`["members", …]`) that actually
 *  carry data — transaction / SMS / cycle queries are volatile and stay
 *  in-memory; a success-with-undefined-data query must not be persisted as
 *  authoritative. */
export function shouldPersistMemberQuery(query: {
  state: { status: string; data?: unknown };
  queryKey: readonly unknown[];
}): boolean {
  return (
    query.state.status === "success" &&
    query.state.data !== undefined &&
    query.queryKey[0] === "members"
  );
}

export function RootProviders({ children }: { children: ReactNode }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        maxAge: PERSIST_MAX_AGE_MS,
        buster: PERSIST_BUSTER,
        dehydrateOptions: {
          shouldDehydrateQuery: shouldPersistMemberQuery,
        },
      }}
    >
      {children}
      <Toaster position="top-center" richColors />
    </PersistQueryClientProvider>
  );
}

/** Must render inside <RouterProvider>. Listens for SIGNED_OUT and redirects. */
export function AuthStateListener() {
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();
  // Track whether a session existed BEFORE the current SIGNED_OUT event.
  // Supabase emits SIGNED_OUT on cold-load when persistSession is null and
  // on intentional signOut() calls; toasting in those cases is misleading.
  // We only surface "Session expirée" when a session truly went from
  // present → absent. The pathname guard additionally suppresses redundant
  // navigates/toasts when the user is already on /login.
  const hadSessionRef = useRef<boolean>(false);
  const locationRef = useRef(location.pathname);

  // Mirror the current pathname into a ref so the onAuthStateChange callback
  // (subscribed once) can read the latest value without re-subscribing on
  // every navigation. Updating the ref in an effect keeps render pure.
  useEffect(() => {
    locationRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    // Seed the prior-session flag BEFORE subscribing.
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled) hadSessionRef.current = Boolean(data.session);
      })
      .catch(() => {
        if (!cancelled) hadSessionRef.current = false;
      });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        const wasSignedIn = hadSessionRef.current;
        hadSessionRef.current = false;
        // On cold-load SIGNED_OUT (no prior session), early-return WITHOUT
        // clearing `signOutStateRef.reason` — it was set by an in-flight
        // `requestSignOut()` whose "real" SIGNED_OUT event is still to come.
        if (!wasSignedIn) return;
        // Story 1.7 — consume the sign-out reason only when a session truly
        // existed. `reason === "explicit"` selects a different toast.
        const reason = signOutStateRef.reason;
        signOutStateRef.reason = null;
        // Story 1.7 — wipe the TanStack Query cache so a subsequent sign-in
        // on the same device cannot flash the previous collector's data
        // (RLS guards server reads, but cached queries would still render
        // before the new fetch resolves).
        queryClient.clear();
        // Story 8.6 — also drop the PERSISTED member cache, otherwise the
        // next collector signing in on this device would rehydrate the
        // previous collector's members from localStorage.
        void queryPersister.removeClient();
        if (locationRef.current !== "/login") {
          const toastKey =
            reason === "explicit" ? "settings.signed_out_success" : "login.session_expired_toast";
          toast(t(toastKey));
          navigate("/login", { replace: true });
        }
        return;
      }
      // Any event that carries a session keeps the prior-session flag true.
      hadSessionRef.current = Boolean(session);
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [navigate, t]);

  // Story 1.6 — NFR-S4 idle timeout (30 min) + absolute lifetime (30 days).
  // Story 1.7 — route through requestSignOut so the idle path also emits the
  // session.signed_out audit event and the listener's toast picks the idle
  // copy (signOutStateRef.reason = "idle" → "Session expirée, reconnectez-
  // vous"). The effect above catches the resulting SIGNED_OUT, clears the
  // query cache, toasts, and navigates to /login.
  useIdleTimeout({
    idleMs: SESSION_IDLE_TIMEOUT_MS,
    absoluteLifetimeMs: SESSION_ABSOLUTE_LIFETIME_MS,
    onExpired: () => {
      void requestSignOut("idle");
    },
  });

  return null;
}

/** Root router element — hosts the auth listener and renders the route outlet. */
export function RouterRoot() {
  return (
    <>
      <AuthStateListener />
      <Outlet />
    </>
  );
}
