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

import { useEffect } from "react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, useNavigate } from "react-router-dom";
import { toast, Toaster } from "sonner";

import { supabase } from "@/infrastructure/supabase/client";
import { useT } from "@/i18n/useT";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 3,
    },
  },
});

export function RootProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  );
}

/** Must render inside <RouterProvider>. Listens for SIGNED_OUT and redirects. */
export function AuthStateListener() {
  const navigate = useNavigate();
  const t = useT();

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        toast(t("login.session_expired_toast"));
        navigate("/login", { replace: true });
      }
    });
    return () => {
      data.subscription.unsubscribe();
    };
  }, [navigate, t]);

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
