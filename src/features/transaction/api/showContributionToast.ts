// Story 4.3 / 4.4 — Just-committed toast helpers (contribution + rattrapage).
//
// Mounts a ProgressiveToast (Story 4.2 component) via sonner's
// `toast.custom` in the `just-committed` state with a 5-second countdown.
// At T-0 the toast auto-dismisses (Story 6.x will replace this with the
// real `sending → delivered` lifecycle once the sms_queue realtime
// subscription lands).
//
// Story 4.4 extracts a shared `mountJustCommittedToast` inner helper so the
// rattrapage variant reuses the same lifecycle / countdown / undo dance
// without copy-paste. The body string is supplied by the caller as a
// `bodyOverride` (Story 4.4 ProgressiveToast extension).
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

export interface ShowRattrapageToastArgs {
  memberName: string;
  daysCovered: number;
  onUndo: () => void;
}

interface MountArgs {
  memberName: string;
  /** Optional override of the default "Cotisation enregistrée — {name}"
   *  copy. Story 4.4 uses this for the rattrapage variant. */
  bodyOverride?: string;
  onUndo: () => void;
}

function mountJustCommittedToast({ memberName, bodyOverride, onUndo }: MountArgs): void {
  let secondsLeft = UNDO_WINDOW_SECONDS;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let undone = false;

  const buildState = () => {
    const base = { kind: "just-committed" as const, secondsLeft, memberName };
    return bodyOverride !== undefined ? { ...base, bodyOverride } : base;
  };

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

export function showContributionToast({ memberName, onUndo }: ShowContributionToastArgs): void {
  mountJustCommittedToast({ memberName, onUndo });
}

/**
 * Story 4.4 — rattrapage variant. Same 5-second undo lifecycle as
 * showContributionToast, but the body reads "Rattrapage enregistré
 * ({daysCovered} jours) — {name}" (BDD line 949 cousin: 4.3 toast for
 * contributions; 4.4 toast for rattrapage).
 *
 * The body string is built here (i18n-wise) and passed via bodyOverride
 * — keeps ProgressiveToast lifecycle kinds narrow.
 */
export function showRattrapageToast({
  memberName,
  daysCovered,
  onUndo,
}: ShowRattrapageToastArgs): void {
  // Inline the i18n key resolution here (single place; small string).
  // The interpolation matches members.toast.rattrapage_committed pattern.
  const bodyOverride = `Rattrapage enregistré (${daysCovered} jours) — ${memberName}`;
  mountJustCommittedToast({ memberName, bodyOverride, onUndo });
}
