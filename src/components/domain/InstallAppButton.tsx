// InstallAppButton — one-tap PWA install from inside the app.
//
// Chrome / Android fires `beforeinstallprompt` when SafariCash is
// installable. We capture it (preventDefault suppresses the browser's
// own mini-infobar) and surface a clear in-app button instead of the
// buried ⋮ → "Add to home screen" menu. Tapping it opens the native
// install dialog.
//
// Renders nothing when the browser never reports installability —
// already installed, unsupported, or iOS Safari (which has no
// `beforeinstallprompt`; iOS users still install via Share → Add to
// Home Screen). Also hides itself once `appinstalled` fires.

import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";

/** The non-standard event Chromium fires when a PWA is installable. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallAppButton(): JSX.Element | null {
  const t = useT();
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event): void => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => setPromptEvent(null);
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (promptEvent === null) {
    return null;
  }

  const handleInstall = async (): Promise<void> => {
    await promptEvent.prompt();
    await promptEvent.userChoice;
    // The prompt is single-use — drop it so the button hides. If the
    // collector dismissed it, the browser re-fires beforeinstallprompt
    // on a later visit and the button comes back.
    setPromptEvent(null);
  };

  return (
    <div className="mx-auto w-full max-w-sm px-4 pb-4">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => void handleInstall()}
      >
        <Download aria-hidden className="h-4 w-4 shrink-0" />
        {t("install.cta")}
      </Button>
    </div>
  );
}
