// Story 1.5 — /dashboard placeholder. Story 9.1 wires the real dashboard.
// Exposes a temporary logout affordance so devs can exercise the auth
// pipeline end-to-end; full sign-out UX is Story 1.7.

import { Link, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { supabase } from "@/infrastructure/supabase/client";

export default function DashboardRoute() {
  const navigate = useNavigate();

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <h1 className="text-title-1 text-text-primary">Tableau de bord</h1>
      <p className="text-body-1 text-text-secondary">
        Story 9.1 câble le vrai tableau de bord. Cette page est un placeholder pour que l&apos;auth
        pipeline soit exerçable.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link to="/members">Mes membres</Link>
        </Button>
        <Button variant="ghost" onClick={handleLogout}>
          Se déconnecter (dev only)
        </Button>
      </div>
    </section>
  );
}
