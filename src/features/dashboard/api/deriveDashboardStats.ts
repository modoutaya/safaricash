// Story 9.1 / FR34 — pure dashboard-stat derivation.
//
// Kept pure + caller-fed (no network, no Date.now) so the four-stat math
// is unit-tested on its own, exactly like `deriveMembersWithMeta`.
//
// Inputs:
//   - members        : the collector's MemberWithMeta[] (from useMembers).
//   - todayTransactions : transactions_decrypted rows whose created_at is on
//     the current UTC day — the query applies the `gte today-start` filter
//     (Senegal / Africa-Dakar is UTC+0, so the UTC day IS the local day).
//   - recentTransactions : the 5 most recent transactions_decrypted rows
//     (the query applies `order created_at desc limit 5`).
// `transactions_decrypted` already excludes undone rows (the view has
// `where undone_at is null`), so no undone filtering is needed here.

import { commission } from "@/domain/cycle";
import type { MemberWithMeta } from "@/features/member";

/** Subset of a `transactions_decrypted` row the dashboard needs. */
export interface DashboardTxRow {
  id: string;
  member_id: string;
  kind: string;
  amount: number;
  created_at: string;
}

export interface DashboardActivity {
  id: string;
  kind: string;
  memberId: string;
  amount: number;
  createdAt: string;
}

export interface DashboardStats {
  activeMembersCount: number;
  todayCollected: number;
  commissionThisCycle: number;
  recentActivity: DashboardActivity[];
}

/** Members counted as "active" for the dashboard — everything except a
 *  finished cycle. */
const ACTIVE_DISPLAY_STATUSES = new Set(["actif", "avance"]);

/** Transaction kinds that count as money COLLECTED (advances are money out). */
const COLLECTED_KINDS = new Set(["contribution", "rattrapage"]);

export function deriveDashboardStats(
  members: MemberWithMeta[],
  todayTransactions: DashboardTxRow[],
  recentTransactions: DashboardTxRow[],
  now: Date = new Date(),
): DashboardStats {
  const active = members.filter((m) => ACTIVE_DISPLAY_STATUSES.has(m.displayStatus));

  // Defensive today-filter: the query already applies `gte today-start`,
  // but a stale persisted `todayTransactions` (rehydrated from a prior day)
  // must not be summed as today's collection. Senegal / Africa-Dakar is
  // UTC+0, so the UTC calendar day IS the local day.
  const todayUtc = now.toISOString().slice(0, 10);
  const todayCollected = todayTransactions
    .filter((t) => COLLECTED_KINDS.has(t.kind) && t.created_at.slice(0, 10) === todayUtc)
    .reduce((sum, t) => sum + t.amount, 0);

  // Sort newest-first before the cap — do NOT rely on the caller's ordering
  // (a deserialized persisted cache may not preserve `created_at` order).
  const recentActivity = [...recentTransactions]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      memberId: t.member_id,
      amount: t.amount,
      createdAt: t.created_at,
    }));

  return {
    activeMembersCount: active.length,
    // INV-4 — commission is exactly 1 day's daily-amount per cycle; use the
    // domain function, never inline the arithmetic.
    commissionThisCycle: active.reduce((sum, m) => sum + commission(m.dailyAmount), 0),
    todayCollected,
    recentActivity,
  };
}
