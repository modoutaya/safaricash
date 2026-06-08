// Story 9.1 / FR34 — pure dashboard-stat derivation.
//
// Kept pure + caller-fed (no network, no Date.now) so the four-stat math
// is unit-tested on its own, exactly like `deriveMembersWithMeta`.
//
// Inputs:
//   - members              : the collector's MemberWithMeta[] (useMembers).
//   - collectedTransactions : transactions_decrypted rows for the CURRENT
//     CALENDAR MONTH (created_at ≥ 1st of month), kind ∈ {contribution,
//     rattrapage} — the running cumulative collection for the month, robust
//     to the cycle-restart state (NOT cycle-scoped, NOT a single day).
//   - recentTransactions   : the 5 most recent transactions_decrypted rows.
// `transactions_decrypted` already excludes undone rows (the view has
// `where undone_at is null`), so no undone filtering is needed here.

import { earnedCommission } from "@/domain/cycle";
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
  /** Cumulative contributions + rattrapages collected this calendar month. */
  cycleCollected: number;
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
  collectedTransactions: DashboardTxRow[],
  recentTransactions: DashboardTxRow[],
): DashboardStats {
  const active = members.filter((m) => ACTIVE_DISPLAY_STATUSES.has(m.displayStatus));

  // The query already scopes to the active cycles and the collected kinds;
  // the kind filter here is defensive (a stale persisted blob, or a query
  // shape change, must never let an advance inflate "collected").
  const collected = collectedTransactions.filter((t) => COLLECTED_KINDS.has(t.kind));
  const cycleCollected = collected.reduce((sum, t) => sum + t.amount, 0);

  // 2026-06-07 — per-member contributedTotal for the active cycle, so the
  // commission tile reflects what's ACTUALLY earned (Σ min(cotisé, daily))
  // rather than the projection Σ dailyAmount over every active member.
  const contributedByMember = new Map<string, number>();
  for (const t of collected) {
    contributedByMember.set(t.member_id, (contributedByMember.get(t.member_id) ?? 0) + t.amount);
  }

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
    // 2026-06-07 — commission effectively earned so far = Σ min(cotisé, daily)
    // over active members (a member who cotisé < 1 day owes only what was
    // versed; one who cotisé nothing owes 0). Was Σ commission(daily) — a
    // projection that over-counted members who hadn't cotisé.
    commissionThisCycle: active.reduce(
      (sum, m) => sum + earnedCommission(contributedByMember.get(m.id) ?? 0, m.dailyAmount),
      0,
    ),
    cycleCollected,
    recentActivity,
  };
}
