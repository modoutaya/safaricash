// Story 9.1 / FR34 — dashboard stats hook.
//
// Composes the existing `useMembers()` (active-count + commission — already
// offline-persisted by Story 8.6) with a `["dashboard", …]`-keyed query for
// the cycle's collected total + the 5 most recent activities. The
// transaction query polls every 60 s (architecture Q-ARCH6 — polling, NOT
// Supabase Realtime); `refetchIntervalInBackground` stays false and the
// default networkMode no-ops the interval while offline.
//
// "Collected" is the running cumulative for the cycles in progress: the
// query filters transactions_decrypted by `cycle_id IN (active cycle ids)`,
// so the figure pairs with the per-cycle commission tile (NOT a single
// day's collection).
//
// The four-stat math lives in the pure `deriveDashboardStats` module.

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { useMembers, type MemberWithMeta } from "@/features/member";
import { supabase } from "@/infrastructure/supabase/client";

import {
  deriveDashboardStats,
  type DashboardStats,
  type DashboardTxRow,
} from "./deriveDashboardStats";

/** Persisted for cold-start offline — see `shouldPersistOfflineReadQuery`. */
export const DASHBOARD_QUERY_KEY = ["dashboard", "transactions"] as const;

/** Architecture Q-ARCH6 — 60 s polling cadence. */
export const DASHBOARD_POLL_INTERVAL_MS = 60_000;

/** Transaction kinds that count as money collected. */
const COLLECTED_KINDS = ["contribution", "rattrapage"] as const;

const dashboardTxRowSchema = z.object({
  id: z.string(),
  member_id: z.string(),
  kind: z.string(),
  // `transactions_decrypted.amount` is numeric(12,0) — PostgREST may
  // serialise it as a string; coerce (matches the project's
  // transactionRowSchema).
  amount: z.coerce.number(),
  created_at: z.string(),
});
const dashboardTxResponseSchema = z.array(dashboardTxRowSchema);

interface DashboardTxData {
  collected: DashboardTxRow[];
  recent: DashboardTxRow[];
}

async function fetchDashboardTransactions(activeCycleIds: string[]): Promise<DashboardTxData> {
  const [recentResult, collectedResult] = await Promise.all([
    supabase
      .from("transactions_decrypted")
      .select("id, member_id, kind, amount, created_at")
      .order("created_at", { ascending: false })
      .limit(5),
    // Cumulative collection for the cycles in progress. No active cycle →
    // skip the round-trip.
    activeCycleIds.length > 0
      ? supabase
          .from("transactions_decrypted")
          .select("id, member_id, kind, amount, created_at")
          .in("cycle_id", activeCycleIds)
          .in("kind", COLLECTED_KINDS)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (recentResult.error) {
    throw new Error(`dashboard recent-activity query failed: ${recentResult.error.message}`);
  }
  if (collectedResult.error) {
    throw new Error(`dashboard collected query failed: ${collectedResult.error.message}`);
  }

  return {
    collected: dashboardTxResponseSchema.parse(collectedResult.data ?? []),
    recent: dashboardTxResponseSchema.parse(recentResult.data ?? []),
  };
}

export interface UseDashboardStatsResult {
  stats: DashboardStats;
  /** The collector's members — exposed for activity-row name resolution. */
  members: MemberWithMeta[];
  /** ms timestamp of the last successful transaction fetch — a pure (clock-
   *  free) time reference for relative-time labels in the activity list. */
  lastUpdatedAt: number;
  isLoading: boolean;
  isError: boolean;
}

export function useDashboardStats(): UseDashboardStatsResult {
  const membersQuery = useMembers();
  const members = membersQuery.data ?? [];

  // Active cycle ids scope the collected total. Sorted so the query key is
  // stable across renders regardless of member ordering.
  const activeCycleIds = members
    .map((m) => m.currentCycle?.id)
    .filter((id): id is string => typeof id === "string")
    .sort();

  const txQuery = useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, activeCycleIds],
    queryFn: () => fetchDashboardTransactions(activeCycleIds),
    enabled: !membersQuery.isLoading,
    refetchInterval: DASHBOARD_POLL_INTERVAL_MS,
    // No `staleTime` — the refetchInterval owns the 60 s cadence; leaving
    // data immediately stale lets a focus / invalidation refresh promptly.
  });

  const tx = txQuery.data ?? { collected: [], recent: [] };

  return {
    stats: deriveDashboardStats(members, tx.collected, tx.recent),
    members,
    lastUpdatedAt: txQuery.dataUpdatedAt,
    isLoading: membersQuery.isLoading || txQuery.isLoading,
    isError: membersQuery.isError || txQuery.isError,
  };
}
