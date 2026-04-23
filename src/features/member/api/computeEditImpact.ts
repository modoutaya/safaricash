// Story 2.5 — pure helper that decides whether a pending edit affects an
// in-flight cycle. The route subscribes to the daily_amount field via
// react-hook-form's `watch` and re-evaluates this on each keystroke; the
// banner copy is rendered iff the result is "cycle-affecting".
//
// Cycle-affecting = the daily_amount field changed AND the current cycle
// is still receiving transactions (active or with_advance). Name and phone
// edits, or edits on a completed/settled/missing cycle, never trigger the
// warning — those don't change FR17 projections.
//
// Companion of computeMemberStats (Story 2.4): both encode the FR17 math.
// TODO(Story 3.2): when the cycle engine domain module lands, both helpers
// move there with a 1-file grep.

import type { CreateMemberInput, CycleStatus, EditImpact } from "../types";

const CYCLE_AFFECTING_STATUSES = new Set<CycleStatus>(["active", "with_advance"]);

export function computeEditImpact(
  initial: CreateMemberInput,
  current: CreateMemberInput,
  cycle: { status: CycleStatus } | null,
): EditImpact {
  if (current.dailyAmount === initial.dailyAmount) return "none";
  if (cycle === null) return "none";
  if (!CYCLE_AFFECTING_STATUSES.has(cycle.status)) return "none";
  return "cycle-affecting";
}
