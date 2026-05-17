// Story 1.5 — AppLayout for session-protected routes.
//
// Mounted under <ProtectedRoute> by the router; wraps authenticated routes
// with a minimal header, an <Outlet /> body, and the bottom navigation.
//
// Story 8.1 / FR41 / UX-DR5 — the persistent ConnectivityIndicator pill in
// the header. The drawer-open state is held here so other surfaces (8.4
// reconciler retry, 8.5 stalled-sync banner) can open the drawer via
// shared state.
//
// BottomNav — the 4-tab-style app navigation deferred by Story 1.7; it now
// owns the link to /settings, so the header's stopgap "Plus" text link was
// removed.

import { useState } from "react";
import { Link, Outlet } from "react-router-dom";

import { BottomNav } from "@/components/BottomNav";
import { useConnectivityState } from "@/features/connectivity/api/useConnectivityState";
import { useReconciler } from "@/features/connectivity/api/useReconciler";
import { ConnectivityIndicator } from "@/features/connectivity/ui/ConnectivityIndicator";
import { ConnectivitySyncDrawer } from "@/features/connectivity/ui/ConnectivitySyncDrawer";
import { useDisputeRealtime } from "@/features/dispute";

export default function AppLayout() {
  const connectivity = useConnectivityState();
  // Story 8.4 — drain offline events on mount + on every window `online`
  // event. Hook is mount-only (no return value).
  useReconciler();
  // Story 10.3 — subscribe to the collector's dispute Realtime channel.
  useDisputeRealtime();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-hairline bg-surface-1 px-4 py-3">
        <Link to="/dashboard" className="text-title-2 font-bold text-primary-700">
          SafariCash
        </Link>
        <ConnectivityIndicator
          state={connectivity.state}
          pendingCount={connectivity.pendingCount}
          onTap={() => setDrawerOpen(true)}
          className="ml-auto"
        />
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <BottomNav />
      <ConnectivitySyncDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        pendingCount={connectivity.pendingCount}
        state={connectivity.state}
      />
    </div>
  );
}
