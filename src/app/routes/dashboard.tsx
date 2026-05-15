// Story 1.5 — /dashboard route.
// Story 9.1 — the real morning-glance dashboard: four polled stats
// (active members / collected today / commission this cycle / recent
// activity), refreshed every 60 s, offline-functional from the cached
// read-model.
//
// Story 3.5 — `<CycleEndingAlert>` stays mounted above the heading
// (Story 9.2 owns its refinements); renders nothing when no cycles are
// in the upcoming-end window or when dismissed.

import { CycleEndingAlert } from "@/features/cycle";
import { useDashboardStats } from "@/features/dashboard/api/useDashboardStats";
import { DashboardStatCards } from "@/features/dashboard/ui/DashboardStatCards";
import { RecentActivity } from "@/features/dashboard/ui/RecentActivity";
import { LocalDataNote } from "@/features/member/ui/LocalDataNote";
import { useT } from "@/i18n/useT";

export default function DashboardRoute() {
  const t = useT();
  const { stats, members, lastUpdatedAt } = useDashboardStats();

  return (
    <section
      className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4"
      aria-label={t("dashboard.title")}
    >
      <CycleEndingAlert />
      <h1 className="text-title-1 text-text-primary">{t("dashboard.title")}</h1>
      <LocalDataNote />
      <DashboardStatCards
        activeMembersCount={stats.activeMembersCount}
        todayCollected={stats.todayCollected}
        commissionThisCycle={stats.commissionThisCycle}
      />
      <RecentActivity activity={stats.recentActivity} members={members} now={lastUpdatedAt} />
    </section>
  );
}
