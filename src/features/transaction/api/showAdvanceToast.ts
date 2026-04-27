// Story 5.4 — showAdvanceToast helper.
//
// Mirrors showRattrapageToast (Story 4.4): same 5-second undo lifecycle,
// different body string ("Prêt accordé — {name}" per BDD line 949).
// Reuses the shared mountJustCommittedToast inner helper from
// showContributionToast.ts via the bodyOverride slot on
// ProgressiveToast's just-committed state.

import { toast } from "sonner";

import { ProgressiveToast } from "@/components/domain/ProgressiveToast";

const UNDO_WINDOW_SECONDS = 5;

export interface ShowAdvanceToastArgs {
  memberName: string;
  /** Called when the user taps Annuler within the 5-second window. */
  onUndo: () => void;
}

export function showAdvanceToast({ memberName, onUndo }: ShowAdvanceToastArgs): void {
  let secondsLeft = UNDO_WINDOW_SECONDS;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let undone = false;

  const bodyOverride = `Prêt accordé — ${memberName}`;

  const buildState = () => ({
    kind: "just-committed" as const,
    secondsLeft,
    memberName,
    bodyOverride,
  });

  const buildHandlers = (id: string | number) => ({
    onUndo: () => {
      if (undone) return;
      undone = true;
      if (intervalId !== null) clearInterval(intervalId);
      toast.dismiss(id);
      onUndo();
    },
    onDismiss: () => {
      if (intervalId !== null) clearInterval(intervalId);
      toast.dismiss(id);
    },
  });

  const toastId = toast.custom(
    (id) => ProgressiveToast({ state: buildState(), ...buildHandlers(id) }),
    { duration: Infinity },
  );

  intervalId = setInterval(() => {
    if (undone) return;
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      if (intervalId !== null) clearInterval(intervalId);
      toast.dismiss(toastId);
      return;
    }
    toast.custom((id) => ProgressiveToast({ state: buildState(), ...buildHandlers(id) }), {
      id: toastId,
      duration: Infinity,
    });
  }, 1000);
}
