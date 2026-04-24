// Story 4.2 — ProgressiveToast (Flow 1 evolving-state toast).
//
// PRESENTATION ONLY. The component is fully props-driven — no internal
// timers, no network state, no sonner integration. Story 4.3's
// useRecordContribution hook owns the state machine + sonner mount +
// 5-second undo timer + sms_queue subscription.
//
// 5 states (BDD lines 818-828):
//   just-committed → "Cotisation enregistrée" + Annuler ({secondsLeft}s)
//   sending        → "Envoi du reçu à {name}…" + spinner
//   delivered      → "Reçu délivré ✓ — {name}"
//   offline        → "Hors-ligne — envoi au prochain réseau"
//   failed         → "Échec de l'envoi — retenter" + Retenter
//
// Mirrors the pure-presentation pattern from MemberActionSheet (Story 4.1).

import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

export type ProgressiveToastState =
  | { kind: "just-committed"; secondsLeft: number; memberName: string }
  | { kind: "sending"; memberName: string }
  | { kind: "delivered"; memberName: string }
  | { kind: "offline"; memberName: string }
  | { kind: "failed"; memberName: string };

export interface ProgressiveToastProps {
  state: ProgressiveToastState;
  onUndo?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}

const TINTS: Record<ProgressiveToastState["kind"], string> = {
  "just-committed": "border-primary-200 bg-primary-50 text-primary-900",
  sending: "border-primary-200 bg-primary-50 text-primary-900",
  delivered: "border-primary-200 bg-primary-50 text-primary-900",
  offline: "border-warning-200 bg-warning-50 text-warning-800",
  failed: "border-destructive/20 bg-destructive/10 text-destructive",
};

export function ProgressiveToast({ state, onUndo, onRetry, onDismiss }: ProgressiveToastProps) {
  const t = useT();
  // Failures interrupt; deliveries/sending don't.
  const role = state.kind === "failed" ? "alert" : "status";

  return (
    <div
      role={role}
      aria-live="polite"
      className={cn(
        "flex items-center gap-3 rounded-md border bg-card p-3 shadow-sm",
        TINTS[state.kind],
      )}
    >
      {state.kind === "sending" ? (
        <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
      ) : null}

      <p className="flex-1 text-body-2">{renderCopy(state, t)}</p>

      {state.kind === "just-committed" && onUndo ? (
        <Button type="button" variant="ghost" size="sm" onClick={onUndo}>
          {t("members.toast.undo_cta", { secondsLeft: state.secondsLeft })}
        </Button>
      ) : null}

      {state.kind === "failed" && onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("members.toast.retry_cta")}
        </Button>
      ) : null}

      {onDismiss ? (
        <button
          type="button"
          aria-label={t("members.toast.dismiss_aria")}
          onClick={onDismiss}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          <X size={16} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function renderCopy(state: ProgressiveToastState, t: ReturnType<typeof useT>): string {
  switch (state.kind) {
    case "just-committed":
      return t("members.toast.committed", { name: state.memberName });
    case "sending":
      return t("members.toast.sending", { name: state.memberName });
    case "delivered":
      return t("members.toast.delivered", { name: state.memberName });
    case "offline":
      return t("members.toast.offline");
    case "failed":
      return t("members.toast.failed");
  }
}
