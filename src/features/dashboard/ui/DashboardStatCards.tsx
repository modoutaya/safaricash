// Story 9.1 / FR34 — the three numeric dashboard stat cards.
//
// Pure presentation — the route owns the data hook. Card visual language
// per ux-design-specification.md:640-667 (16 px radius, hairline border,
// no heavy shadow).

import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";

export interface DashboardStatCardsProps {
  activeMembersCount: number;
  todayCollected: number;
  commissionThisCycle: number;
}

function StatCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hairline bg-card p-4">
      <span className="text-caption text-text-secondary">{label}</span>
      <span
        className="text-title-1 text-text-primary"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
    </div>
  );
}

export function DashboardStatCards({
  activeMembersCount,
  todayCollected,
  commissionThisCycle,
}: DashboardStatCardsProps): JSX.Element {
  const t = useT();
  return (
    <div
      role="group"
      aria-label={t("dashboard.stats_label")}
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
    >
      <StatCard label={t("dashboard.stat.active_members")} value={String(activeMembersCount)} />
      <StatCard
        label={t("dashboard.stat.today_collected")}
        value={formatFcfaAmount(todayCollected)}
      />
      <StatCard
        label={t("dashboard.stat.commission")}
        value={formatFcfaAmount(commissionThisCycle)}
      />
    </div>
  );
}
