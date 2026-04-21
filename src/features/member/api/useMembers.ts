// Story 2.1 — member list query + derivation.
//
// Single PostgREST round-trip via `members_decrypted` (RLS applies through
// `security_invoker = true`, migration 0005) with embedded cycles +
// transaction timestamps. Zod validates the response shape; derivation
// produces MemberWithMeta view-model rows, filtered to exclude hidden
// statuses, sorted by recency-of-interaction.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import { supabase } from "@/infrastructure/supabase/client";

import {
  MEMBERS_QUERY_KEY,
  membersListRowSchema,
  type CycleRow,
  type MemberWithMeta,
  type MembersListRow,
} from "../types";
import { deriveMemberStatus } from "./deriveMemberStatus";
import { sortMembersByRecency } from "./sortMembersByRecency";

const MS_PER_DAY = 86_400_000;
const CYCLE_TOTAL_DAYS = 30;

/** Pick the cycle that represents the member's CURRENT state. Cycles with
 *  status in ('active', 'with_advance') qualify; if multiple, the highest
 *  cycle_number wins (defensive — schema invariant ensures ≤1 in practice). */
function pickCurrentCycle(cycles: CycleRow[] | null | undefined): CycleRow | null {
  if (!cycles || cycles.length === 0) return null;
  const candidates = cycles.filter((c) => c.status === "active" || c.status === "with_advance");
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.cycle_number > best.cycle_number ? c : best));
}

/** Compute 1-indexed cycle day from a YYYY-MM-DD start_date. Clamps to
 *  [1, CYCLE_TOTAL_DAYS] — the caller (CycleProgressBar) clamps again
 *  defensively. */
function computeCycleDay(startDate: string, now: Date = new Date()): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const diffDays = Math.floor((now.getTime() - start) / MS_PER_DAY) + 1;
  return Math.min(CYCLE_TOTAL_DAYS, Math.max(1, diffDays));
}

/** Pure transform used by the hook + by tests. Exported so unit tests can
 *  exercise it without TanStack boilerplate. */
export function deriveMembersWithMeta(
  rows: MembersListRow[],
  now: Date = new Date(),
): MemberWithMeta[] {
  const derived = rows.map((row) => {
    const currentCycle = pickCurrentCycle(row.cycles);
    const displayStatus = deriveMemberStatus(row, currentCycle);
    const latestTxAt = (row.transactions ?? [])
      .map((t) => t.created_at)
      .reduce<string | null>((best, ts) => (best === null || ts > best ? ts : best), null);
    return {
      id: row.id,
      name: row.name,
      phoneNumber: row.phone_number,
      dailyAmount: row.daily_amount,
      displayStatus,
      currentCycle: currentCycle
        ? {
            id: currentCycle.id,
            startDate: currentCycle.start_date,
            dayNumber: computeCycleDay(currentCycle.start_date, now),
          }
        : null,
      latestInteractionAt: latestTxAt ?? row.created_at,
      createdAt: row.created_at,
    };
  });

  const visible = derived.filter((r) => r.displayStatus !== "hidden");
  const sorted = sortMembersByRecency(visible);
  // Strip the internal createdAt field + narrow displayStatus to DisplayStatus.
  return sorted.map<MemberWithMeta>(({ createdAt: _createdAt, displayStatus, ...rest }) => ({
    ...rest,
    displayStatus: displayStatus as Exclude<typeof displayStatus, "hidden">,
  }));
}

const membersListResponseSchema = z.array(membersListRowSchema);

async function fetchMembers(): Promise<MembersListRow[]> {
  const { data, error } = await supabase
    .from("members_decrypted")
    .select(
      `id, collector_id, name, phone_number, daily_amount, status, created_at, updated_at,
       cycles:cycles!cycles_member_id_fkey (id, cycle_number, start_date, end_date, status),
       transactions:transactions!transactions_member_id_fkey (created_at)`,
    )
    // Can't recency-sort server-side on an aggregate; client sort covers it.
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`members list query failed: ${error.message}`);
  }
  return membersListResponseSchema.parse(data ?? []);
}

export function useMembers(): UseQueryResult<MemberWithMeta[], Error> {
  return useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: async () => {
      const rows = await fetchMembers();
      return deriveMembersWithMeta(rows);
    },
    staleTime: 30_000,
  });
}

// Re-export for downstream stories.
export { MEMBERS_QUERY_KEY };
