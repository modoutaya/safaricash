// Story 9.1 / FR34 — dashboard stats hook.
//
// Composes the existing `useMembers()` (active-count + commission — already
// offline-persisted by Story 8.6) with a `["dashboard", …]`-keyed query for
// today's collection + the 5 most recent activities. The transaction query
// polls every 60 s (architecture Q-ARCH6 — polling, NOT Supabase Realtime);
// `refetchIntervalInBackground` stays false and the default networkMode
// no-ops the interval while offline.
//
// The four-stat math lives in the pure `deriveDashboardStats` module.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
  today: DashboardTxRow[];
  recent: DashboardTxRow[];
}

async function fetchDashboardTransactions(): Promise<DashboardTxData> {
  // Senegal / Africa-Dakar is UTC+0 — the UTC day is the local day.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [todayResult, recentResult] = await Promise.all([
    supabase
      .from("transactions_decrypted")
      .select("id, member_id, kind, amount, created_at")
      .gte("created_at", todayStart.toISOString()),
    supabase
      .from("transactions_decrypted")
      .select("id, member_id, kind, amount, created_at")
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  if (todayResult.error) {
    throw new Error(`dashboard today-collection query failed: ${todayResult.error.message}`);
  }
  if (recentResult.error) {
    throw new Error(`dashboard recent-activity query failed: ${recentResult.error.message}`);
  }

  return {
    today: dashboardTxResponseSchema.parse(todayResult.data ?? []),
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
  // Date-stamp the query key so a cold start on a new day uses a fresh key —
  // the persisted previous-day blob is keyed differently and is NOT
  // rehydrated as "today". The `useState` lazy initializer keeps render pure.
  const [todayKey] = useState(() => new Date().toISOString().slice(0, 10));
  const txQuery = useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, todayKey],
    queryFn: fetchDashboardTransactions,
    refetchInterval: DASHBOARD_POLL_INTERVAL_MS,
    // No `staleTime` — the refetchInterval owns the 60 s cadence; leaving
    // data immediately stale lets a focus / invalidation refresh promptly.
  });

  const members = membersQuery.data ?? [];
  const tx = txQuery.data ?? { today: [], recent: [] };

  return {
    // `new Date(<number>)` is a pure construction — the today-filter
    // reference tracks the last successful fetch.
    stats: deriveDashboardStats(members, tx.today, tx.recent, new Date(txQuery.dataUpdatedAt)),
    members,
    lastUpdatedAt: txQuery.dataUpdatedAt,
    isLoading: membersQuery.isLoading || txQuery.isLoading,
    isError: membersQuery.isError || txQuery.isError,
  };
}
