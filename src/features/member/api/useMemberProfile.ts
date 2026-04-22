// Story 2.4 — useMemberProfile(id) hook.
//
// Three parallel PostgREST round-trips (members_decrypted + cycles +
// transactions_decrypted) joined in JS. Same pattern as Story 2.1's
// useMembers — RLS applies transitively on all three tables. Returns
// undefined data when the row does not exist (RLS reject OR bogus id),
// so the caller can render the "membre introuvable" branch.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

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
import { computeMemberStats } from "./computeMemberStats";

export interface MemberProfileData {
  member: MemberRow;
  currentCycle: CycleRow | null;
  transactions: TransactionRow[];
  stats: MemberStats;
}

const transactionsResponseSchema = z.array(transactionRowSchema);
const cyclesResponseSchema = z.array(cycleRowSchema.extend({ member_id: z.string().uuid() }));

/** Pick the cycle that represents the member's CURRENT state (matches
 *  Story 2.1's pickCurrentCycle). */
function pickCurrentCycle(cycles: CycleRow[]): CycleRow | null {
  const candidates = cycles.filter((c) => c.status === "active" || c.status === "with_advance");
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.cycle_number > best.cycle_number ? c : best));
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

  const currentCycle = pickCurrentCycle(cycles.map(({ member_id: _m, ...rest }) => rest));
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

  return { member, currentCycle, transactions, stats };
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
