// Story 9.1 / FR34 — dashboard stats hook.
//
// Composes the existing `useMembers()` (active-count + commission — already
// offline-persisted by Story 8.6) with a `["dashboard", …]`-keyed query for
// the cycle's collected total + the 5 most recent activities. The
// transaction query polls every 60 s (architecture Q-ARCH6 — polling, NOT
// Supabase Realtime); `refetchIntervalInBackground` stays false and the
// default networkMode no-ops the interval while offline.
//
// 2026-06-08 — "Collected" + "commission" aggregate over the CURRENT
// CALENDAR MONTH (1st of the month → now), NOT the cycle: the query filters
// transactions_decrypted by `created_at >= <1st of month>`. This is robust
// to the monthly cycle-restart not having run — the dashboard always shows
// this month's real figures regardless of each member's cycle state.
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

/** First day of `now`'s month at 00:00 UTC, ISO string — the start of the
 *  dashboard's aggregate window. Senegal = UTC+0, so this is local midnight
 *  on the 1st. Exported so tests can reproduce the query key deterministically. */
export function currentMonthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

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

async function fetchDashboardTransactions(monthStart: string): Promise<DashboardTxData> {
  const [recentResult, collectedResult] = await Promise.all([
    supabase
      .from("transactions_decrypted")
      .select("id, member_id, kind, amount, created_at")
      .order("created_at", { ascending: false })
      .limit(5),
    // Current-month collection (1st of month → now), NOT cycle-scoped — so
    // the figures are correct even when a member's cycle hasn't restarted.
    // RLS scopes rows to the authenticated collector.
    supabase
      .from("transactions_decrypted")
      .select("id, member_id, kind, amount, created_at")
      .gte("created_at", monthStart)
      .in("kind", COLLECTED_KINDS),
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

  // Aggregate window = the current calendar month (1st → now), independent of
  // any member's cycle state. Stable within the month → stable query key.
  const monthStart = currentMonthStartIso();

  const txQuery = useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, monthStart],
    queryFn: () => fetchDashboardTransactions(monthStart),
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
