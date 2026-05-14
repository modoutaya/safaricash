// Story 8.3 — offline-phase toast helper.
//
// Mounts a ProgressiveToast in the `offline` state with the copy
// "Hors-ligne — envoi au prochain réseau" (i18n key
// `members.toast.offline`). No 5-second undo dance, no SMS lifecycle
// chain — purely informational. Auto-dismisses after 4 s; sonner's
// default duration handles the timeout (we override to a finite value
// so the toast doesn't hang around indefinitely).
//
// Kind-agnostic: callable from contribution / advance / rattrapage
// flows alike. Consumers (MemberList, advance route) read `wasOffline`
// from the mutation's success payload and call this helper instead of
// `showContributionToast` / `showAdvanceToast` / `showRattrapageToast`
// when offline.

import { toast } from "sonner";

import { ProgressiveToast } from "@/components/domain/ProgressiveToast";

const OFFLINE_TOAST_DURATION_MS = 4_000;

export interface ShowOfflineToastArgs {
  memberName: string;
}

export function showOfflineToast({ memberName }: ShowOfflineToastArgs): void {
  toast.custom(
    (id) =>
      ProgressiveToast({
        state: { kind: "offline", memberName },
        onDismiss: () => {
          toast.dismiss(id);
        },
      }),
    { duration: OFFLINE_TOAST_DURATION_MS },
  );
}
