// Story 2.7 — RestartCycleDialog.
//
// Lightweight 2-CTA confirmation modal hosting useRestartCycle. Built on
// the native <dialog> element — zero new deps, browser handles focus
// trap, ESC-to-close, and aria-modal semantics. The shadcn Dialog
// primitive isn't installed yet (architecture lists it but no story has
// pulled it in); when it lands, swap this component's shell, keep the
// behaviour.
//
// Behaviour contract:
//   - Open via the controlled `open` prop. Parent flips it on tap.
//   - Cancel → closes via onOpenChange(false). No mutation fired.
//   - Confirm → fires useRestartCycle().mutateAsync(memberId). On success
//     → close + parent toasts. On rejection → stays open, renders inline
//     error copy (mapped from RestartCycleErrorCode).

import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cycleLengthDays, deriveCycleBounds } from "@/domain/cycle";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

import { useRestartCycle, type RestartCycleErrorCode } from "../api/useRestartCycle";

export interface RestartCycleDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  memberId: string;
  memberName: string;
  /** Called after the mutation resolves successfully (parent toasts). */
  onSuccess: (newCycleId: string) => void;
}

function errorCopyKey(code: RestartCycleErrorCode): TranslationKey {
  switch (code) {
    case "unauthorized":
      return "members.profile.restart.error.unauthorized";
    case "not_restartable":
      return "members.profile.restart.error.not_restartable";
    case "not_found":
      return "members.profile.restart.error.not_found";
    case "network":
      return "members.profile.restart.error.network";
    case "unknown":
    default:
      return "members.profile.restart.error.unknown";
  }
}

export function RestartCycleDialog({
  open,
  onOpenChange,
  memberId,
  memberName,
  onSuccess,
}: RestartCycleDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const restart = useRestartCycle();

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  // Reset the mutation's error state whenever the dialog re-opens, so a
  // previous failure doesn't haunt the next attempt.
  useEffect(() => {
    if (open) restart.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleConfirm = async () => {
    try {
      const newCycleId = await restart.mutateAsync(memberId);
      onSuccess(newCycleId);
      onOpenChange(false);
    } catch {
      // Error is surfaced via restart.error → inline copy below.
    }
  };

  const errorBannerKey = restart.error !== null ? errorCopyKey(restart.error.code) : null;

  // Story 11.4 — preview the restarted cycle's actual length (calendar-month
  // aligned). `restart_member_cycle` server-side calls `derive_cycle_bounds`
  // with today's date — mirror that here so the dialog body never promises
  // a 30-day cycle when the saver will actually get e.g. 24 days.
  const nextBounds = deriveCycleBounds(new Date().toISOString().slice(0, 10));
  const nextCycleLength = cycleLengthDays(nextBounds.startDate, nextBounds.endDate);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      onCancel={(e) => {
        // ESC-to-close: <dialog> fires `cancel` then `close`. Prevent
        // closing while the mutation is in flight.
        if (restart.isPending) e.preventDefault();
      }}
      aria-labelledby="restart-cycle-dialog-title"
      aria-describedby="restart-cycle-dialog-body"
      className="m-auto w-[90%] max-w-sm rounded-lg border border-neutral-200 bg-background p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id="restart-cycle-dialog-title" className="text-headline-2 text-text-primary">
          {t("members.profile.restart.dialog_title")}
        </h2>
        <p id="restart-cycle-dialog-body" className="text-body-1 text-text-secondary">
          {t("members.profile.restart.dialog_body", { name: memberName, total: nextCycleLength })}
        </p>

        {errorBannerKey !== null ? (
          <p role="alert" className="text-body-2 text-destructive">
            {t(errorBannerKey)}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 pt-2">
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={handleConfirm}
            disabled={restart.isPending}
          >
            {restart.isPending
              ? t("members.profile.restart.cta_submitting")
              : t("members.profile.restart.dialog_confirm")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            onClick={() => onOpenChange(false)}
            disabled={restart.isPending}
          >
            {t("members.profile.restart.dialog_cancel")}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
