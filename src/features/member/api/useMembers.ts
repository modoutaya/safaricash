// Story 2.1 — member list query + derivation.
//
// Three parallel PostgREST round-trips (members_decrypted + cycles +
// transaction timestamps) joined in-JS. Originally written with a single
// embedded select, but PostgREST does not auto-resolve FK relationships
// through views (`members_decrypted` has no FK metadata), and forcing the
// `table!fk_name` syntax failed to embed. Three parallel queries still
// incur ~1 wall-clock RTT via Promise.all and keep the transform straight-
// forward. RLS applies transitively on all three tables.
//
// Membership in `members_decrypted` requires EXECUTE on
// public.vault_decrypt — granted to authenticated in migration
// 20260421000002_vault_decrypt_grant_authenticated.sql.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import {
  computeOpeningBalance,
  computeProjectedFinalBalance,
  cycleDay,
  cycleLengthDays,
  settle,
  type OpeningBalanceCycle,
} from "@/domain/cycle";
import { supabase } from "@/infrastructure/supabase/client";

import {
  MEMBERS_QUERY_KEY,
  cycleRowSchema,
  memberRowSchema,
  transactionKindSchema,
  type CycleRow,
  type MemberRow,
  type MemberWithMeta,
} from "../types";
import { deriveMemberStatus } from "./deriveMemberStatus";
import { sortMembersByRecency } from "./sortMembersByRecency";

/** Pick the cycle that represents the member's CURRENT state. Cycles with
 *  status in ('active', 'with_advance') qualify; if multiple, the highest
 *  cycle_number wins (defensive — schema invariant ensures ≤1 in practice). */
function pickCurrentCycle(cycles: CycleRow[]): CycleRow | null {
  const candidates = cycles.filter((c) => c.status === "active" || c.status === "with_advance");
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.cycle_number > best.cycle_number ? c : best));
}

/** Input shape for the pure transform — decoupled from the PostgREST call
 *  so unit tests can drive it directly. */
export interface RawMembersData {
  members: MemberRow[];
  cyclesByMember: Map<string, CycleRow[]>;
  latestTxByMember: Map<string, string>;
  /** cycle_id → Σ advance amounts booked in that cycle (undone rows excluded). */
  advancesByCycle: Map<string, number>;
}

/** Pure transform: raw PostgREST rows → sorted, filtered view-model. */
export function deriveMembersWithMeta(
  data: RawMembersData,
  now: Date = new Date(),
): MemberWithMeta[] {
  const derived = data.members.map((row) => {
    const memberCycles = data.cyclesByMember.get(row.id) ?? [];
    const currentCycle = pickCurrentCycle(memberCycles);
    const displayStatus = deriveMemberStatus(row, currentCycle);
    const latestTxAt = data.latestTxByMember.get(row.id) ?? null;
    const cycleAdvancesTotal = currentCycle ? (data.advancesByCycle.get(currentCycle.id) ?? 0) : 0;
    // Story 12.3 — opening_balance carry-over. We already have ALL the
    // member's cycles + per-cycle advance totals in scope; the TS engine
    // helper walks the chain recursively. Mirrors SQL
    // `compute_opening_balance` — cross-checked by the Deno contract test.
    const openingBalanceCycles: OpeningBalanceCycle[] = memberCycles.map((c) => ({
      id: c.id,
      cycleNumber: c.cycle_number,
      startDate: c.start_date,
      endDate: c.end_date,
      status: c.status,
    }));
    const openingBalance = currentCycle
      ? computeOpeningBalance(
          openingBalanceCycles,
          data.advancesByCycle,
          row.daily_amount,
          currentCycle.id,
        )
      : 0;

    // Story 12.4 — oldest cycle with status='completed' across all this
    // member's cycles. FIFO drain — see useMemberProfile for the same
    // logic on the per-member surface. Returns null when none.
    const awaitingCycle =
      memberCycles
        .filter((c) => c.status === "completed")
        .sort((a, b) => a.cycle_number - b.cycle_number)[0] ?? null;
    const awaitingSettlement: { cycleId: string; payout: number } | null = awaitingCycle
      ? {
          cycleId: awaitingCycle.id,
          payout: settle(
            row.daily_amount,
            [data.advancesByCycle.get(awaitingCycle.id) ?? 0],
            cycleLengthDays(awaitingCycle.start_date, awaitingCycle.end_date) - 1,
            computeOpeningBalance(
              openingBalanceCycles,
              data.advancesByCycle,
              row.daily_amount,
              awaitingCycle.id,
            ),
          ),
        }
      : null;

    // Story 12.4 — surface "Payé le DD/MM" badge for 7 days post-payment.
    // Pick the most recent settled_at across all settled cycles; suppress
    // when older than 7 days (the positive feedback should fade so the UI
    // doesn't permanently nudge about past payments).
    const sevenDaysAgoMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const recentSettledAt =
      memberCycles
        .filter((c) => c.status === "settled" && c.settled_at != null)
        .map((c) => c.settled_at!)
        .filter((ts) => new Date(ts).getTime() >= sevenDaysAgoMs)
        .sort()
        .at(-1) ?? null;
    const lastSettlementAt: string | null = recentSettledAt;

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
            endDate: currentCycle.end_date,
            dayNumber: cycleDay(currentCycle.start_date, currentCycle.end_date, now),
            cycleLength: cycleLengthDays(currentCycle.start_date, currentCycle.end_date),
            openingBalance,
          }
        : null,
      latestInteractionAt: latestTxAt ?? row.created_at,
      cycleAdvancesTotal,
      awaitingSettlement,
      lastSettlementAt,
      projectedBalance: currentCycle
        ? computeProjectedFinalBalance(
            row.daily_amount,
            cycleAdvancesTotal,
            cycleLengthDays(currentCycle.start_date, currentCycle.end_date) - 1,
            openingBalance,
          )
        : null,
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

const membersResponseSchema = z.array(memberRowSchema);
const cyclesResponseSchema = z.array(cycleRowSchema.extend({ member_id: z.string().uuid() }));
const transactionsResponseSchema = z.array(
  z.object({
    member_id: z.string().uuid(),
    cycle_id: z.string().uuid(),
    kind: transactionKindSchema,
    // transactions_decrypted.amount is vault-decrypted numeric(12,0);
    // PostgREST may serialise it as a string — coerce (matches the
    // dashboard's dashboardTxRowSchema).
    amount: z.coerce.number(),
    created_at: z.string(),
  }),
);

async function fetchRawMembersData(): Promise<RawMembersData> {
  const [membersResult, cyclesResult, transactionsResult] = await Promise.all([
    supabase
      .from("members_decrypted")
      .select("id, collector_id, name, phone_number, daily_amount, status, created_at, updated_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("cycles")
      .select("id, member_id, cycle_number, start_date, end_date, status, settled_at"),
    // transactions_decrypted: `amount` is vault-decrypted here (the raw
    // transactions table stores it encrypted), and the view already
    // filters undone rows (Story 4.5) — so no .is("undone_at", null).
    supabase.from("transactions_decrypted").select("member_id, cycle_id, kind, amount, created_at"),
  ]);

  if (membersResult.error) {
    throw new Error(`members list query failed: ${membersResult.error.message}`);
  }
  if (cyclesResult.error) {
    throw new Error(`cycles query failed: ${cyclesResult.error.message}`);
  }
  if (transactionsResult.error) {
    throw new Error(`transactions query failed: ${transactionsResult.error.message}`);
  }

  const members = membersResponseSchema.parse(membersResult.data ?? []);
  const cycles = cyclesResponseSchema.parse(cyclesResult.data ?? []);
  const transactions = transactionsResponseSchema.parse(transactionsResult.data ?? []);

  const cyclesByMember = new Map<string, CycleRow[]>();
  for (const cycle of cycles) {
    const { member_id: memberId, ...rest } = cycle;
    const list = cyclesByMember.get(memberId) ?? [];
    list.push(rest);
    cyclesByMember.set(memberId, list);
  }

  const latestTxByMember = new Map<string, string>();
  const advancesByCycle = new Map<string, number>();
  for (const tx of transactions) {
    const prev = latestTxByMember.get(tx.member_id);
    if (prev === undefined || tx.created_at > prev) {
      latestTxByMember.set(tx.member_id, tx.created_at);
    }
    if (tx.kind === "advance") {
      advancesByCycle.set(tx.cycle_id, (advancesByCycle.get(tx.cycle_id) ?? 0) + tx.amount);
    }
  }

  return { members, cyclesByMember, latestTxByMember, advancesByCycle };
}

export function useMembers(): UseQueryResult<MemberWithMeta[], Error> {
  return useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: async () => {
      const raw = await fetchRawMembersData();
      return deriveMembersWithMeta(raw);
    },
    staleTime: 30_000,
  });
}

// Re-export for downstream stories.
export { MEMBERS_QUERY_KEY };
