// Story 1.5 — /dashboard placeholder. Story 9.1 wires the real dashboard.
// The temporary dev-only sign-out affordance was removed in Story 1.7 — the
// canonical sign-out now lives at /settings.
//
// Story 3.5 — `<CycleEndingAlert>` mounted above the heading; renders
// nothing when no cycles are in the upcoming-end window or when dismissed.

import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { CycleEndingAlert } from "@/features/cycle";

export default function DashboardRoute() {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4">
      <CycleEndingAlert />
      <h1 className="text-title-1 text-text-primary">Tableau de bord</h1>
      <p className="text-body-1 text-text-secondary">
        Story 9.1 câble le vrai tableau de bord. Cette page est un placeholder pour que l&apos;auth
        pipeline soit exerçable.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link to="/members">Mes membres</Link>
        </Button>
      </div>
    </section>
  );
}
