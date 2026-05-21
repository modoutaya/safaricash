// Story 2.4 — useMemberProfile(id) hook.
//
// Three parallel PostgREST round-trips (members_decrypted + cycles +
// transactions_decrypted) joined in JS. Same pattern as Story 2.1's
// useMembers — RLS applies transitively on all three tables. Returns
// undefined data when the row does not exist (RLS reject OR bogus id),
// so the caller can render the "membre introuvable" branch.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import {
  computeMemberStats,
  computeOpeningBalance,
  cycleLengthDays,
  settle,
  type OpeningBalanceCycle,
} from "@/domain/cycle";
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
  /** Story 12.4 — the oldest cycle of THIS member that is still in
   *  `status='completed'` (= awaiting manual settlement). null when
   *  none. Drives the "Clôturer le cycle" CTA gate AND the settlement
   *  route's cycle target.
   *
   *  Why oldest first: a collector who skipped a month's settlement
   *  ends up with multiple 'completed' cycles; we drain them FIFO so
   *  the oldest owed is paid first.
   *
   *  Pre-Phase-B (Story 12.3): could be equal to currentCycle (cycle
   *  reached end_date but wasn't restarted yet).
   *  Post-Phase-B: typically lives in previousCycles, because the cron
   *  always creates a new 'active' cycle on the 1st. */
  cycleAwaitingSettlement: CycleRow | null;
  /** Story 12.4 — payout amount for the awaiting-settlement cycle, or
   *  null when there's no such cycle. Drives the inline "À régler" row
   *  on MemberProfile + the SettlementSummaryCard payout. */
  awaitingSettlementPayout: number | null;
  transactions: TransactionRow[];
  /** Story 12.4 — every transaction across ALL of this member's cycles
   *  (no filter). Story 7.4's settlement route needs the awaiting-cycle's
   *  advances which are NOT in `transactions` (filtered to currentCycle).
   *  Existing consumers stay on `transactions` for back-compat. */
  allTransactions: TransactionRow[];
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
      .select(
        // Story 6.7 — sms_opt_out drives the resend-disabled UI gate in the
        // TransactionReceiptSheet (column added by Story 6.5 migration 0044).
        "id, collector_id, name, phone_number, daily_amount, status, created_at, updated_at, sms_opt_out",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("cycles")
      .select("id, member_id, cycle_number, start_date, end_date, status, settled_at")
      .eq("member_id", id),
    supabase
      .from("transactions_decrypted")
      // Story 6.7 — receipt_token feeds the share button (Web Share API
      // composes ${VITE_RECEIPT_URL_BASE}/{token} client-side).
      .select("id, member_id, cycle_id, kind, amount, cycle_day, created_at, receipt_token")
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

  // Story 12.3 — opening_balance carry-over. Build the per-cycle
  // advance totals (excluding undone) once, then recurse via
  // computeOpeningBalance. Mirrors SQL `compute_opening_balance` —
  // cross-checked by compute-opening-balance.contract.test.ts.
  const advancesByCycleId = new Map<string, number>();
  for (const tx of allTransactions) {
    if (tx.kind !== "advance") continue;
    // undone advances are already excluded by transactions_decrypted view.
    advancesByCycleId.set(tx.cycle_id, (advancesByCycleId.get(tx.cycle_id) ?? 0) + tx.amount);
  }
  const openingBalanceCycles: OpeningBalanceCycle[] = cleanedCycles.map((c) => ({
    id: c.id,
    cycleNumber: c.cycle_number,
    startDate: c.start_date,
    endDate: c.end_date,
    status: c.status,
  }));
  const openingBalance = currentCycle
    ? computeOpeningBalance(
        openingBalanceCycles,
        advancesByCycleId,
        member.daily_amount,
        currentCycle.id,
      )
    : 0;

  const stats = computeMemberStats(
    transactions,
    { dailyAmount: member.daily_amount },
    currentCycle ? { startDate: currentCycle.start_date, endDate: currentCycle.end_date } : null,
    undefined,
    openingBalance,
  );

  // Story 12.4 — oldest cycle in status='completed' across ALL of this
  // member's cycles (current + history). FIFO: a collector who skipped
  // a month settles the older debt first. Returns null when no cycle
  // awaits settlement (every cycle is 'active' / 'with_advance' /
  // 'settled').
  const cycleAwaitingSettlement: CycleRow | null =
    cleanedCycles
      .filter((c) => c.status === "completed")
      .sort((a, b) => a.cycle_number - b.cycle_number)[0] ?? null;

  // Pre-compute the payout for the awaiting-settlement cycle so the
  // profile surface can display "À régler : X F CFA" without re-deriving
  // the math. Uses the cycle's OWN advances + its OWN opening_balance
  // (computed recursively from previous cycles), mirroring the SQL
  // commit_cycle_settlement formula.
  const awaitingSettlementPayout: number | null = cycleAwaitingSettlement
    ? settle(
        member.daily_amount,
        [advancesByCycleId.get(cycleAwaitingSettlement.id) ?? 0],
        cycleLengthDays(cycleAwaitingSettlement.start_date, cycleAwaitingSettlement.end_date) - 1,
        computeOpeningBalance(
          openingBalanceCycles,
          advancesByCycleId,
          member.daily_amount,
          cycleAwaitingSettlement.id,
        ),
      )
    : null;

  return {
    member,
    currentCycle,
    previousCycles,
    cycleAwaitingSettlement,
    awaitingSettlementPayout,
    transactions,
    allTransactions,
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
