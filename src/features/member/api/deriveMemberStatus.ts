// Story 2.1 — pure function: DB enum → UI display status.
//
// Layering: lives in features/member/api/ (view-model), not domain/.
// domain/ is reserved for cycle-engine / audit-hash / transaction-invariants.

import type { CycleRow, DerivedStatus, MemberRow } from "../types";

export function deriveMemberStatus(
  member: Pick<MemberRow, "status">,
  currentCycle: Pick<CycleRow, "status"> | null | undefined,
): DerivedStatus {
  if (member.status === "deleted" || member.status === "paused") {
    return "hidden";
  }
  if (member.status === "completed") {
    return "termine";
  }
  // member.status === "active" from here on.
  if (currentCycle?.status === "with_advance") {
    return "avance";
  }
  if (currentCycle?.status === "active") {
    return "actif";
  }
  // Active member with no current cycle — shouldn't happen once Story 2.2
  // enforces the "member.created ⇒ cycle.created" invariant. Fall back to
  // 'actif' so the list doesn't break, but dev-warn so the bug surfaces.
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console -- dev-only invariant breach
    console.warn(
      "[deriveMemberStatus] active member has no active/with_advance cycle; displaying 'actif'. Story 2.2 invariant breach.",
    );
  }
  return "actif";
}
