// Story 1.5 — /members/new placeholder. Story 2.2 will ship the real
// creation flow.

import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export default function MembersNewRoute() {
  return (
    <section className="mx-auto flex w-full max-w-sm flex-col items-center gap-6 px-4 py-8 text-center">
      <div aria-hidden="true" className="text-[64px] leading-none opacity-30">
        👤
      </div>
      <h1 className="text-title-1 text-text-primary">Création de membre</h1>
      <p className="text-body-1 text-text-secondary">
        Story 2.2 câble le formulaire de création de membre. Cette page est un placeholder
        d&apos;atterrissage depuis l&apos;écran vide.
      </p>
      <Button asChild variant="outline" size="lg" className="w-full">
        <Link to="/members">Retour aux membres</Link>
      </Button>
    </section>
  );
}
