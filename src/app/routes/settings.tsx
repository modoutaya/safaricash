// Story 1.7 — /settings (Plus tab) route.
//
// Minimal surface for MVP: page heading + a single "Se déconnecter" button.
// Future stories extend this surface (Story 2.3 adds "Révoquer l'accès aux
// contacts"; later stories add other operator actions). The 4-tab bottom nav
// (Dashboard / Membres / Rapports / Plus) is a separate UI story — for now
// the route is reachable via a header link in AppLayout.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { requestSignOut } from "@/features/auth/api/signOut";
import { hasContactsConsent, revokeContactsConsent } from "@/features/member";
import { useT } from "@/i18n/useT";

export default function SettingsRoute() {
  const t = useT();
  const [isPending, setIsPending] = useState(false);
  // Story 2.3 — re-derive the consent banner state on every revoke so the
  // text flips immediately. localStorage doesn't fire 'storage' events for
  // the same window, so a state-based read is the simplest path.
  const [consent, setConsent] = useState<boolean>(() => hasContactsConsent());
  const pendingRef = useRef(false);
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

  function handleRevokeContacts(): void {
    revokeContactsConsent();
    setConsent(false);
    toast.success(t("settings_contacts.revoke_toast"));
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

      <section className="flex flex-col gap-3 rounded-lg border border-hairline bg-card p-4">
        <h2 className="text-title-2 text-text-primary">{t("settings_contacts.title")}</h2>
        <p className="text-body-2 text-text-secondary">
          {consent ? t("settings_contacts.granted") : t("settings_contacts.not_granted")}
        </p>
        {consent ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={handleRevokeContacts}
            className="w-full"
          >
            {t("settings_contacts.revoke_cta")}
          </Button>
        ) : null}
      </section>
    </main>
  );
}
