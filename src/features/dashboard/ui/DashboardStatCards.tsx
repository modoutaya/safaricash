// Story 9.1 / FR34 — the three numeric dashboard stats.
//
// Rendered inside the green DashboardHero as a compact 3-up row of glass
// tiles: white value on top, small uppercase label below. Always a row —
// never stacks — sized to fit a ~320 px hero content width.
//
// Pure presentation — the route owns the data hook.
// Visual reference: 03-mockups.html .dash-stats / .dash-stat.

import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";

export interface DashboardStatCardsProps {
  activeMembersCount: number;
  cycleCollected: number;
  commissionThisCycle: number;
}

function StatTile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-md bg-primary-foreground/15 px-2 py-3 text-center">
      <span
        className="text-title-2 text-primary-foreground"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
      <span className="text-overline uppercase text-primary-foreground/80">{label}</span>
    </div>
  );
}

export function DashboardStatCards({
  activeMembersCount,
  cycleCollected,
  commissionThisCycle,
}: DashboardStatCardsProps): JSX.Element {
  const t = useT();
  return (
    <div role="group" aria-label={t("dashboard.stats_label")} className="mt-5 flex gap-2">
      <StatTile label={t("dashboard.stat.active_members")} value={String(activeMembersCount)} />
      <StatTile label={t("dashboard.stat.collected")} value={formatFcfaAmount(cycleCollected)} />
      <StatTile
        label={t("dashboard.stat.commission")}
        value={formatFcfaAmount(commissionThisCycle)}
      />
    </div>
  );
}
