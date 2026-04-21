// Story 1.7 — /settings (Plus tab) route.
//
// Minimal surface for MVP: page heading + a single "Se déconnecter" button.
// Future stories extend this surface (Story 2.3 adds "Révoquer l'accès aux
// contacts"; later stories add other operator actions). The 4-tab bottom nav
// (Dashboard / Membres / Rapports / Plus) is a separate UI story — for now
// the route is reachable via a header link in AppLayout.

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { requestSignOut } from "@/features/auth/api/signOut";
import { useT } from "@/i18n/useT";

export default function SettingsRoute() {
  const t = useT();
  const [isPending, setIsPending] = useState(false);
  // Synchronous guard against double-tap: setState batches so `isPending`
  // does not update between clicks in the same tick.
  const pendingRef = useRef(false);
  // Track mount status: on success the SIGNED_OUT handler navigates away
  // and unmounts this component; the finally block MUST NOT setState after.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  async function handleSignOut() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setIsPending(true);
    try {
      await requestSignOut("explicit");
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setIsPending(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-title-1 text-text-primary">{t("settings.title")}</h1>
      </header>

      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        onClick={handleSignOut}
        disabled={isPending}
        aria-busy={isPending}
      >
        {t("settings.signout_cta")}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {isPending ? t("settings.signout_loading") : ""}
      </span>
    </main>
  );
}
