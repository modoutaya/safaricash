// Story 1.5 — AppLayout for session-protected routes.
//
// Mounted under <ProtectedRoute> by the router; wraps authenticated routes
// with a minimal header and an <Outlet /> body.
//
// Story 1.7 — added a "Plus" text link to /settings so the sign-out CTA is
// reachable without a bottom-nav (the 4-tab nav is deferred to a dedicated
// UI story).
//
// Story 8.1 / FR41 / UX-DR5 — added the persistent ConnectivityIndicator
// pill in the header. The drawer-open state is held here so future
// stories (8.4 reconciler retry, 8.5 stalled-sync banner) can open the
// drawer from elsewhere via shared state.

import { useState } from "react";
import { Link, Outlet } from "react-router-dom";

import { useConnectivityState } from "@/features/connectivity/api/useConnectivityState";
import { ConnectivityIndicator } from "@/features/connectivity/ui/ConnectivityIndicator";
import { ConnectivitySyncDrawer } from "@/features/connectivity/ui/ConnectivitySyncDrawer";
import { useT } from "@/i18n/useT";

export default function AppLayout() {
  const t = useT();
  const connectivity = useConnectivityState();
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
        <Link
          to="/settings"
          className="text-body-2 font-medium text-primary-700 underline-offset-4 hover:underline"
        >
          {t("settings.title")}
        </Link>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <ConnectivitySyncDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        pendingCount={connectivity.pendingCount}
      />
    </div>
  );
}
