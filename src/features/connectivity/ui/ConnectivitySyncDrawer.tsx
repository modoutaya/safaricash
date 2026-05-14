// Story 8.1 / UX-DR5 — sync-status drawer skeleton.
//
// Native <dialog> shell opened by the ConnectivityIndicator. Story 8.1
// ships the title + close button + empty-state / placeholder message.
// Stories 8.3 (outbox), 8.4 (reconciler retry CTAs), 8.5 (stalled-sync
// banner) will fill the body with the real pending-operations list +
// retry affordances.
//
// Mirrors Story 6.6 ResendHistoryDialog + Story 7.4 SettlementReauthDialog
// pattern: useRef<HTMLDialogElement> + useEffect for showModal/close,
// programmatic focus on the close button at mount (jsx-a11y/no-autofocus
// enforced).

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";

export interface ConnectivitySyncDrawerProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  pendingCount: number;
  // NOTE (Story 8.4): the connectivity `state` will be added back as a
  // prop when the drawer body conditions on it (e.g. a "Retry all" CTA
  // visible only in the `sync-failed` state). Until then, accepting an
  // unused `state` here would mislead future readers — kept out per
  // code-review patch #3.
}

export function ConnectivitySyncDrawer({
  open,
  onOpenChange,
  pendingCount,
}: ConnectivitySyncDrawerProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const t = useT();

  // showModal / close shim — same pattern as Story 6.6 / 7.4 dialogs.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  // Mount-time programmatic focus on the close button (UX-DR5 + Story 7.2
  // pattern; jsx-a11y/no-autofocus rule forbids the HTML autoFocus attr).
  useEffect(() => {
    if (open) {
      closeBtnRef.current?.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      aria-labelledby="connectivity-drawer-title"
      className="m-auto w-[90%] max-w-md rounded-lg border border-neutral-200 bg-background p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      {open ? (
        <div className="flex flex-col gap-4 p-6">
          <header className="flex items-center justify-between gap-3">
            <h2 id="connectivity-drawer-title" className="text-headline-2 text-text-primary">
              {t("connectivity.drawer.title")}
            </h2>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t("connectivity.drawer.close_label")}
              className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            >
              <X size={20} aria-hidden />
            </button>
          </header>

          {pendingCount === 0 ? (
            <p className="text-body-2 text-text-secondary">{t("connectivity.drawer.empty")}</p>
          ) : (
            <p className="text-body-2 text-text-secondary">
              {t("connectivity.drawer.placeholder_pending", { count: pendingCount })}
            </p>
          )}

          <div className="flex flex-col gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => onOpenChange(false)}
            >
              {t("connectivity.drawer.close_label")}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
