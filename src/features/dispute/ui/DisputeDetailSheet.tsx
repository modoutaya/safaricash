// Story 10.3 / FR33b — dispute detail modal.
//
// Native <dialog> centered modal (same pattern as TransactionReceiptSheet):
// shows the saver's optional free-text message + the flagged-at timestamp,
// and a "Marquer comme résolue" action. Pure presentation — the parent
// route wires onResolve to useResolveDispute.

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";

import type { DisputeRow } from "../types";

export interface DisputeDetailSheetProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  dispute: DisputeRow;
  onResolve: () => void;
  /** True while the resolve mutation is in flight. */
  isResolving: boolean;
}

const FLAGGED_AT_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatFlaggedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return FLAGGED_AT_FORMATTER.format(date);
}

export function DisputeDetailSheet({
  open,
  onOpenChange,
  dispute,
  onResolve,
  isResolving,
}: DisputeDetailSheetProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  const close = () => onOpenChange(false);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  const hasMessage = dispute.notes !== null && dispute.notes.trim() !== "";

  return (
    /* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */
    <dialog
      ref={dialogRef}
      onClose={close}
      onClick={handleBackdropClick}
      aria-labelledby="dispute-detail-sheet-title"
      className="m-auto w-full max-w-md rounded-2xl border border-hairline bg-card p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      <div className="flex flex-col gap-4 p-6" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3">
          <h2 id="dispute-detail-sheet-title" className="text-headline-2 text-text-primary">
            {t("dispute.detail.title")}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={t("dispute.detail.close_label")}
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          >
            <X size={20} aria-hidden />
          </button>
        </header>

        <dl className="flex flex-col gap-3 text-body-2">
          <div className="flex flex-col gap-1">
            <dt className="text-text-secondary">{t("dispute.detail.message_label")}</dt>
            <dd className="text-text-primary">
              {hasMessage ? dispute.notes : t("dispute.detail.message_empty")}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-secondary">{t("dispute.detail.date_label")}</dt>
            <dd className="text-text-primary">{formatFlaggedAt(dispute.flagged_at)}</dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2 pt-2">
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={() => onResolve()}
            disabled={isResolving}
            aria-busy={isResolving}
          >
            {isResolving ? t("dispute.detail.resolving_cta") : t("dispute.detail.resolve_cta")}
          </Button>
        </div>
      </div>
    </dialog>
    /* eslint-enable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */
  );
}
