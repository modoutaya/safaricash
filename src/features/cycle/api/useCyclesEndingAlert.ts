// Story 3.5 / FR20 — derivation hook for the dashboard cycles-ending alert.
//
// Reads the existing `useMembers()` cache (Story 2.1) — no new RTT, no new
// query key. Filters via `selectMembersWithCycleEndingSoon`. Per-session
// dismiss state is stored in sessionStorage so navigating away and back
// keeps the alert hidden within the tab session, but reopening the tab
// resurfaces it (BDD line 786 — "reappears on next app load").
//
// Lives under `features/cycle/api/` because it's a derivation, not a
// query — TanStack Query stays out of this file.

import { useCallback, useState } from "react";

import { DEFAULT_CYCLE_ENDING_WINDOW_DAYS } from "@/domain/cycle";
import { useMembers } from "@/features/member/api/useMembers";
import type { MemberWithMeta } from "@/features/member";

import { selectMembersWithCycleEndingSoon } from "./selectMembersWithCycleEndingSoon";

export const CYCLE_ENDING_ALERT_DISMISS_KEY = "sc_cycle_ending_alert_dismissed";

export interface UseCyclesEndingAlertResult {
  count: number;
  members: MemberWithMeta[];
  isDismissed: boolean;
  dismiss: () => void;
  isLoading: boolean;
}

function readDismissedFlag(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  return sessionStorage.getItem(CYCLE_ENDING_ALERT_DISMISS_KEY) === "1";
}

export function useCyclesEndingAlert(
  windowDays: number = DEFAULT_CYCLE_ENDING_WINDOW_DAYS,
): UseCyclesEndingAlertResult {
  const { data, isLoading } = useMembers();
  // Local mirror of the sessionStorage flag — `useState` so the React
  // tree re-renders when `dismiss()` runs.
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissedFlag());

  const members = data ? selectMembersWithCycleEndingSoon(data, windowDays) : [];

  const dismiss = useCallback(() => {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(CYCLE_ENDING_ALERT_DISMISS_KEY, "1");
    }
    setDismissed(true);
  }, []);

  return {
    count: members.length,
    members,
    isDismissed: dismissed,
    dismiss,
    isLoading,
  };
}
