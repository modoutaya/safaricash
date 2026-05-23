// Story 3.5 / FR20 — feature-level selector picking the members whose
// current cycle is within the upcoming-end window.
//
// Pure / synchronous / unit-testable. No I/O, no React. Derives entirely
// from the existing `useMembers()` view-model (Story 2.1) — no new RTT.
// Lives at the feature layer because it consumes `MemberWithMeta`
// (a view-model type), not a domain entity.

import { isCycleInUpcomingEndWindow } from "@/domain/cycle";
import type { MemberWithMeta } from "@/features/member";

export function selectMembersWithCycleEndingSoon(
  members: ReadonlyArray<MemberWithMeta>,
  windowDays: number,
): MemberWithMeta[] {
  return members.filter((m) => {
    if (m.currentCycle === null) return false;
    return isCycleInUpcomingEndWindow(
      m.currentCycle.dayNumber,
      windowDays,
      m.currentCycle.cycleLength,
    );
  });
}
