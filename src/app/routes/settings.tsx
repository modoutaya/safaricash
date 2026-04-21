// Story 1.7 — /settings (Plus tab) route.
//
// Minimal surface for MVP: page heading + a single "Se déconnecter" button.
// Future stories extend this surface (Story 2.3 adds "Révoquer l'accès aux
// contacts"; later stories add other operator actions). The 4-tab bottom nav
// (Dashboard / Membres / Rapports / Plus) is a separate UI story — for now
// the route is reachable via a header link in AppLayout.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { requestSignOut } from "@/features/auth/api/signOut";
import { useT } from "@/i18n/useT";

export default function SettingsRoute() {
  const t = useT();
  const [isPending, setIsPending] = useState(false);

  async function handleSignOut() {
    // Prevent double-tap while the sign-out is in flight. requestSignOut
    // does not throw; AuthStateListener picks up SIGNED_OUT and handles the
    // toast + redirect, so we do NOT navigate from here.
    setIsPending(true);
    try {
      await requestSignOut("explicit");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-sm flex-col gap-6 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-title-1 text-text-primary">{t("settings.title")}</h1>
      </header>

      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        onClick={handleSignOut}
        disabled={isPending}
      >
        {isPending ? t("settings.signout_loading") : t("settings.signout_cta")}
      </Button>
    </section>
  );
}
