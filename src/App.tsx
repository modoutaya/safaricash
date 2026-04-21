// Story 1.5 — AppLayout for session-protected routes.
//
// Mounted under <ProtectedRoute> by the router; wraps authenticated routes
// with a minimal header and an <Outlet /> body. Visual polish (connectivity
// indicator, search field, avatar menu) lands in later stories.
//
// Story 1.7 — added a "Plus" text link to /settings so the sign-out CTA is
// reachable without a bottom-nav (the 4-tab nav is deferred to a dedicated
// UI story).

import { Link, Outlet } from "react-router-dom";

import { useT } from "@/i18n/useT";

export default function AppLayout() {
  const t = useT();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b border-hairline bg-surface-1 px-4 py-3">
        <Link to="/dashboard" className="text-title-2 font-bold text-primary-700">
          SafariCash
        </Link>
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
    </div>
  );
}
