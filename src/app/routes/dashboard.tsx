// Story 1.5 — /dashboard route.
// Story 9.1 — the morning-glance dashboard: a green hero with the three
// 60 s-polled stats (active members / collected today / commission this
// cycle), quick-action shortcuts, and a recent-activity list. Offline-
// functional from the cached read-model.
//
// Story 3.5 — <CycleEndingAlert> renders nothing when no cycles are in
// the upcoming-end window or when dismissed.
//
// Visual reference: 03-mockups.html (Dashboard Principal).

import { CycleEndingAlert } from "@/features/cycle";
import { useCollectorName } from "@/features/dashboard/api/useCollectorName";
import { useDashboardStats } from "@/features/dashboard/api/useDashboardStats";
import { DashboardHero } from "@/features/dashboard/ui/DashboardHero";
import { DashboardQuickActions } from "@/features/dashboard/ui/DashboardQuickActions";
import { RecentActivity } from "@/features/dashboard/ui/RecentActivity";
import { LocalDataNote } from "@/features/member/ui/LocalDataNote";
import { useT } from "@/i18n/useT";

export default function DashboardRoute() {
  const t = useT();
  const { stats, members, lastUpdatedAt } = useDashboardStats();
  const collectorName = useCollectorName();

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col" aria-label={t("dashboard.title")}>
      <DashboardHero
        greetingName={collectorName}
        activeMembersCount={stats.activeMembersCount}
        todayCollected={stats.todayCollected}
        commissionThisCycle={stats.commissionThisCycle}
      />
      <div className="flex flex-col gap-4 p-4">
        <CycleEndingAlert />
        <DashboardQuickActions />
        <LocalDataNote />
        <RecentActivity activity={stats.recentActivity} members={members} now={lastUpdatedAt} />
      </div>
    </section>
  );
}
