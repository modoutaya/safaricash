// Story 1.5 — Session-required route guard.
//
// <ProtectedRoute> wraps any route that requires an authenticated session.
// It reads the Supabase session (cached, but the SDK's getSession is
// technically async) and, if absent, redirects to /login. When a session
// exists it simply renders the child <Outlet />.
//
// Subscribes to onAuthStateChange so a token expiry / SIGNED_OUT mid-render
// re-evaluates the guard rather than keeping a stale "authenticated" view.
// The idle-timeout policy (NFR-S4, 30 min) is owned by Story 1.6; this
// guard + the SIGNED_OUT listener in providers.tsx are the mechanism that
// will carry out the redirect once Story 1.6 arms the timer.

import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; session: Session }
  | { status: "anonymous" };

export function ProtectedRoute() {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Initial session read. Catch rejections (corrupt localStorage, Safari
    // private-mode storage throttling) so the guard falls back to anonymous
    // rather than remaining stuck in "loading" forever → blank page.
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setState({ status: "anonymous" });
          return;
        }
        setState(
          data.session
            ? { status: "authenticated", session: data.session }
            : { status: "anonymous" },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "anonymous" });
      });

    // Live-update on SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED so a session
    // expiring AFTER initial mount flips the guard to "anonymous" and the
    // route redirects to /login on the next render.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setState(session ? { status: "authenticated", session } : { status: "anonymous" });
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  if (state.status === "loading") {
    // Minimal flicker; Supabase getSession is cached and usually resolves
    // in <5 ms. We still do not want to briefly show /login if the user
    // IS signed in, so render nothing until we know.
    return null;
  }
  if (state.status === "anonymous") {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
