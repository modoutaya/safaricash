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

import { supabase } from "@/infrastructure/supabase/client";

import {
  MEMBERS_QUERY_KEY,
  cycleRowSchema,
  memberRowSchema,
  transactionTimestampSchema,
  type CycleRow,
  type MemberRow,
  type MemberWithMeta,
} from "../types";
import { deriveMemberStatus } from "./deriveMemberStatus";
import { sortMembersByRecency } from "./sortMembersByRecency";

const MS_PER_DAY = 86_400_000;
const CYCLE_TOTAL_DAYS = 30;

/** Pick the cycle that represents the member's CURRENT state. Cycles with
 *  status in ('active', 'with_advance') qualify; if multiple, the highest
 *  cycle_number wins (defensive — schema invariant ensures ≤1 in practice). */
function pickCurrentCycle(cycles: CycleRow[]): CycleRow | null {
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

/** Input shape for the pure transform — decoupled from the PostgREST call
 *  so unit tests can drive it directly. */
export interface RawMembersData {
  members: MemberRow[];
  cyclesByMember: Map<string, CycleRow[]>;
  latestTxByMember: Map<string, string>;
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

const membersResponseSchema = z.array(memberRowSchema);
const cyclesResponseSchema = z.array(cycleRowSchema.extend({ member_id: z.string().uuid() }));
const transactionsResponseSchema = z.array(
  transactionTimestampSchema.extend({ member_id: z.string().uuid() }),
);

async function fetchRawMembersData(): Promise<RawMembersData> {
  const [membersResult, cyclesResult, transactionsResult] = await Promise.all([
    supabase
      .from("members_decrypted")
      .select("id, collector_id, name, phone_number, daily_amount, status, created_at, updated_at")
      .order("created_at", { ascending: false }),
    supabase.from("cycles").select("id, member_id, cycle_number, start_date, end_date, status"),
    supabase.from("transactions").select("member_id, created_at"),
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
  for (const tx of transactions) {
    const prev = latestTxByMember.get(tx.member_id);
    if (prev === undefined || tx.created_at > prev) {
      latestTxByMember.set(tx.member_id, tx.created_at);
    }
  }

  return { members, cyclesByMember, latestTxByMember };
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
