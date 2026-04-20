// Story 1.5 — AppLayout for session-protected routes.
//
// Mounted under <ProtectedRoute> by the router; wraps authenticated routes
// with a minimal header and an <Outlet /> body. Visual polish (connectivity
// indicator, search field, avatar menu) lands in later stories.

import { Link, Outlet } from "react-router-dom";

export default function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b border-hairline bg-surface-1 px-4 py-3">
        <Link to="/dashboard" className="text-title-2 font-bold text-primary-700">
          SafariCash
        </Link>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
