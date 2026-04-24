// Story 2.4 — useMemberProfile(id) hook.
//
// Three parallel PostgREST round-trips (members_decrypted + cycles +
// transactions_decrypted) joined in JS. Same pattern as Story 2.1's
// useMembers — RLS applies transitively on all three tables. Returns
// undefined data when the row does not exist (RLS reject OR bogus id),
// so the caller can render the "membre introuvable" branch.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import { computeMemberStats } from "@/domain/cycle";
import { supabase } from "@/infrastructure/supabase/client";

import {
  MEMBER_PROFILE_QUERY_KEY,
  cycleRowSchema,
  memberRowSchema,
  transactionRowSchema,
  type CycleRow,
  type MemberRow,
  type MemberStats,
  type TransactionRow,
} from "../types";

export interface MemberProfileData {
  member: MemberRow;
  currentCycle: CycleRow | null;
  /** Story 2.7 — completed/settled cycles older than `currentCycle`,
   *  newest first. Drives the "Cycles précédents" read-only section. */
  previousCycles: CycleRow[];
  transactions: TransactionRow[];
  /** Story 2.6 — count of transactions across ALL cycles (current +
   *  previous). Drives the delete dialog summary copy. */
  totalTransactionsCount: number;
  stats: MemberStats;
}

const transactionsResponseSchema = z.array(transactionRowSchema);
const cyclesResponseSchema = z.array(cycleRowSchema.extend({ member_id: z.string().uuid() }));

/** Pick the cycle that represents the member's CURRENT state.
 *
 *  Story 2.7 widens the heuristic: if no active/with_advance cycle exists,
 *  fall back to the highest-numbered completed/settled cycle so the profile
 *  can render the just-completed cycle's context AND the "Redémarrer le
 *  cycle" action. The list-level `useMembers.pickCurrentCycle` keeps the
 *  active-only semantics — that's a different surface. */
function pickCurrentCycle(cycles: CycleRow[]): CycleRow | null {
  if (cycles.length === 0) return null;
  const active = cycles.filter((c) => c.status === "active" || c.status === "with_advance");
  const pool = active.length > 0 ? active : cycles;
  return pool.reduce((best, c) => (c.cycle_number > best.cycle_number ? c : best));
}

export async function fetchProfile(id: string): Promise<MemberProfileData | undefined> {
  const [memberResult, cyclesResult, transactionsResult] = await Promise.all([
    supabase
      .from("members_decrypted")
      .select("id, collector_id, name, phone_number, daily_amount, status, created_at, updated_at")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("cycles")
      .select("id, member_id, cycle_number, start_date, end_date, status")
      .eq("member_id", id),
    supabase
      .from("transactions_decrypted")
      .select("id, member_id, cycle_id, kind, amount, cycle_day, created_at")
      .eq("member_id", id),
  ]);

  if (memberResult.error) {
    throw new Error(`member profile query failed: ${memberResult.error.message}`);
  }
  if (cyclesResult.error) {
    throw new Error(`cycles query failed: ${cyclesResult.error.message}`);
  }
  if (transactionsResult.error) {
    throw new Error(`transactions query failed: ${transactionsResult.error.message}`);
  }

  if (memberResult.data === null) return undefined;

  const member = memberRowSchema.parse(memberResult.data);
  const cycles = cyclesResponseSchema.parse(cyclesResult.data ?? []);
  const allTransactions = transactionsResponseSchema.parse(transactionsResult.data ?? []);

  const cleanedCycles = cycles.map(({ member_id: _m, ...rest }) => rest);
  const currentCycle = pickCurrentCycle(cleanedCycles);
  // Story 2.7 — read-only history: completed/settled cycles, newest first,
  // excluding whatever pickCurrentCycle promoted to currentCycle.
  const previousCycles = cleanedCycles
    .filter(
      (c) => (c.status === "completed" || c.status === "settled") && c.id !== currentCycle?.id,
    )
    .sort((a, b) => b.cycle_number - a.cycle_number);
  // Filter transactions to the current cycle ONLY for the rendered list.
  // Stats compute over the same subset (out-of-cycle transactions don't
  // count toward the projected balance of the current cycle).
  const transactions = currentCycle
    ? allTransactions.filter((tx) => tx.cycle_id === currentCycle.id)
    : [];
  const stats = computeMemberStats(
    transactions,
    { dailyAmount: member.daily_amount },
    currentCycle ? { startDate: currentCycle.start_date } : null,
  );

  return {
    member,
    currentCycle,
    previousCycles,
    transactions,
    totalTransactionsCount: allTransactions.length,
    stats,
  };
}

export function useMemberProfile(
  id: string | undefined,
): UseQueryResult<MemberProfileData | undefined, Error> {
  return useQuery({
    queryKey: [...MEMBER_PROFILE_QUERY_KEY, id],
    queryFn: () => fetchProfile(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}
