// Story 1.5 — /non-registered dead-end screen (Flow 5 step J).
//
// Single CTA "Appeler SafariCash" (tel: link) + secondary back-to-login.
// Background bg-destructive-bg per UX Flow 5 mermaid styling. The founder
// phone lives in src/lib/contact.ts — single source of truth (R-OP1).

import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { FOUNDER_SUPPORT_PHONE } from "@/lib/contact";
import { useT } from "@/i18n/useT";

export default function NonRegisteredRoute() {
  const t = useT();
  return (
    <main className="flex min-h-screen items-center justify-center bg-destructive-bg px-4 py-8">
      <section
        aria-labelledby="non-registered-title"
        className="mx-auto flex w-full max-w-sm flex-col items-center gap-6 text-center"
      >
        <div aria-hidden="true" className="text-[64px] leading-none opacity-40">
          🔒
        </div>
        <h1 id="non-registered-title" className="text-title-1 text-destructive-text">
          {t("login.non_registered_title")}
        </h1>
        <p className="text-body-1 text-destructive-text">{t("login.non_registered_body")}</p>
        <Button asChild size="lg" className="w-full">
          <a href={`tel:${FOUNDER_SUPPORT_PHONE}`}>{t("login.non_registered_cta_call")}</a>
        </Button>
        <Button asChild variant="link">
          <Link to="/login">{t("login.non_registered_cta_back")}</Link>
        </Button>
      </section>
    </main>
  );
}
