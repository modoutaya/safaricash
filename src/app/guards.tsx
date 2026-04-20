// Story 1.5 — Session-required route guard.
//
// <ProtectedRoute> wraps any route that requires an authenticated session.
// It synchronously reads the cached Supabase session (no network) and, if
// absent, redirects to /login. When a session exists it simply renders the
// child <Outlet />.
//
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
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setState(
        data.session ? { status: "authenticated", session: data.session } : { status: "anonymous" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    // Minimal flicker; Supabase getSession is synchronous from cache most of
    // the time (<5ms), but we still do not want to briefly show /login if the
    // user IS signed in. Render nothing.
    return null;
  }
  if (state.status === "anonymous") {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
