// Story 12.1 — Journal tab: collector's members + per-member current /
// previous cycle bounds + last activity timestamp (for sort).
//
// Same data sources as Story 2.1's useMembers (members_decrypted + cycles +
// transactions_decrypted) but returns a journal-specific view-model that
// exposes BOTH current AND previous cycle bounds (needed for the period
// filter) and the last activity timestamp (needed for the "activité récente"
// sort). Parallel hook to keep Journal's concern separate from MemberList's.
//
// All three queries are RLS-scoped to the calling collector. No new RPC.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import { supabase } from "@/infrastructure/supabase/client";

import { cycleRowSchema, memberRowSchema } from "@/features/member";

export const JOURNAL_MEMBERS_QUERY_KEY = ["journal", "members"] as const;

export interface JournalCycleBounds {
  id: string;
  cycleNumber: number;
  startDate: string;
  endDate: string;
}

export interface JournalMember {
  id: string;
  name: string;
  currentCycle: JournalCycleBounds | null;
  previousCycle: JournalCycleBounds | null;
  /** Latest `transactions.created_at` for this member, or null when the
   *  member has no transactions yet. Sort key for the default view. */
  lastActivityAt: string | null;
}

const cycleRowWithMemberSchema = cycleRowSchema.extend({ member_id: z.string().uuid() });
const txTimestampSchema = z.object({
  member_id: z.string().uuid(),
  created_at: z.string(),
});

/** Pure transform — exported for unit tests. */
export function deriveJournalMembers(
  members: ReadonlyArray<z.infer<typeof memberRowSchema>>,
  cyclesByMember: Map<string, z.infer<typeof cycleRowWithMemberSchema>[]>,
  latestTxByMember: Map<string, string>,
): JournalMember[] {
  return members.map((row) => {
    const memberCycles = (cyclesByMember.get(row.id) ?? []).slice();
    // Pick the highest-numbered active-ish cycle as "current"; the one
    // immediately before it (cycle_number = current - 1) as "previous".
    // Identical semantics to useMembers.pickCurrentCycle so the same row
    // reads as current on both surfaces.
    const active = memberCycles.filter((c) => c.status === "active" || c.status === "with_advance");
    const current =
      active.length > 0
        ? active.reduce((best, c) => (c.cycle_number > best.cycle_number ? c : best))
        : null;
    const previous = current
      ? (memberCycles.find((c) => c.cycle_number === current.cycle_number - 1) ?? null)
      : // No active cycle → fall back to the most recent settled/completed
        // (defensive: a fully-settled member's "previous cycle" still has
        // history worth viewing).
        memberCycles.length > 0
        ? memberCycles.reduce((best, c) => (c.cycle_number > best.cycle_number ? c : best))
        : null;

    return {
      id: row.id,
      name: row.name,
      currentCycle: current
        ? {
            id: current.id,
            cycleNumber: current.cycle_number,
            startDate: current.start_date,
            endDate: current.end_date,
          }
        : null,
      previousCycle: previous
        ? {
            id: previous.id,
            cycleNumber: previous.cycle_number,
            startDate: previous.start_date,
            endDate: previous.end_date,
          }
        : null,
      lastActivityAt: latestTxByMember.get(row.id) ?? null,
    };
  });
}

async function fetchJournalMembers(): Promise<JournalMember[]> {
  const [membersResult, cyclesResult, txTimestampsResult] = await Promise.all([
    supabase
      .from("members_decrypted")
      .select("id, collector_id, name, phone_number, daily_amount, status, created_at, updated_at"),
    supabase.from("cycles").select("id, member_id, cycle_number, start_date, end_date, status"),
    // We only need `created_at` for the sort. Filtering or aggregating in SQL
    // would need a custom RPC; client-side aggregation over the collector's
    // transactions (RLS-scoped, typically a few thousand rows max) is fine.
    supabase.from("transactions_decrypted").select("member_id, created_at"),
  ]);
  if (membersResult.error) {
    throw new Error(`journal members query failed: ${membersResult.error.message}`);
  }
  if (cyclesResult.error) {
    throw new Error(`journal cycles query failed: ${cyclesResult.error.message}`);
  }
  if (txTimestampsResult.error) {
    throw new Error(`journal tx timestamps query failed: ${txTimestampsResult.error.message}`);
  }

  const members = z.array(memberRowSchema).parse(membersResult.data ?? []);
  const cycles = z.array(cycleRowWithMemberSchema).parse(cyclesResult.data ?? []);
  const txTimestamps = z.array(txTimestampSchema).parse(txTimestampsResult.data ?? []);

  const cyclesByMember = new Map<string, z.infer<typeof cycleRowWithMemberSchema>[]>();
  for (const cycle of cycles) {
    const list = cyclesByMember.get(cycle.member_id) ?? [];
    list.push(cycle);
    cyclesByMember.set(cycle.member_id, list);
  }

  const latestTxByMember = new Map<string, string>();
  for (const tx of txTimestamps) {
    const prev = latestTxByMember.get(tx.member_id);
    if (prev === undefined || tx.created_at > prev) {
      latestTxByMember.set(tx.member_id, tx.created_at);
    }
  }

  return deriveJournalMembers(members, cyclesByMember, latestTxByMember);
}

export function useJournalMembers(): UseQueryResult<JournalMember[], Error> {
  return useQuery({
    queryKey: JOURNAL_MEMBERS_QUERY_KEY,
    queryFn: fetchJournalMembers,
    staleTime: 30_000,
  });
}
