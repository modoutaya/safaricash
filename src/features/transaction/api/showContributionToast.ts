// Story 4.3 — showContributionToast helper.
//
// Mounts a ProgressiveToast (Story 4.2 component) via sonner's
// `toast.custom` in the `just-committed` state with a 5-second countdown.
// At T-0 the toast auto-dismisses (Story 6.x will replace this with the
// real `sending → delivered` lifecycle once the sms_queue realtime
// subscription lands).
//
// Undo path: caller-supplied `onUndo` runs the actual rollback (DELETE the
// transaction). We just stop the timer + dismiss the toast.

import { toast } from "sonner";

import { ProgressiveToast } from "@/components/domain/ProgressiveToast";

const UNDO_WINDOW_SECONDS = 5;

export interface ShowContributionToastArgs {
  memberName: string;
  /** Called when the user taps Annuler within the 5-second window. */
  onUndo: () => void;
}

export function showContributionToast({ memberName, onUndo }: ShowContributionToastArgs): void {
  let secondsLeft = UNDO_WINDOW_SECONDS;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let undone = false;

  const toastId = toast.custom(
    (id) =>
      ProgressiveToast({
        state: { kind: "just-committed", secondsLeft, memberName },
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
      }),
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
    // Re-render the toast with the updated countdown.
    toast.custom(
      (id) =>
        ProgressiveToast({
          state: { kind: "just-committed", secondsLeft, memberName },
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
        }),
      { id: toastId, duration: Infinity },
    );
  }, 1000);
}
