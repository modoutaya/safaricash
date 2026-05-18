// Story 9.1 / FR34 — the dashboard hero.
//
// Full-bleed green-gradient header: a greeting, a subtitle, and the three
// 60 s-polled stats (DashboardStatCards) as glass tiles. Pure presentation
// — the route owns the data hook.
//
// Visual reference: 03-mockups.html .dash-hero.

import { DashboardStatCards } from "@/features/dashboard/ui/DashboardStatCards";
import { useT } from "@/i18n/useT";

export interface DashboardHeroProps {
  /** Collector's name; null falls back to a generic greeting. */
  greetingName: string | null;
  activeMembersCount: number;
  todayCollected: number;
  commissionThisCycle: number;
}

export function DashboardHero({
  greetingName,
  activeMembersCount,
  todayCollected,
  commissionThisCycle,
}: DashboardHeroProps): JSX.Element {
  const t = useT();
  const firstName = greetingName?.trim().split(/\s+/)[0];
  const greetingTarget =
    firstName && firstName.length > 0 ? firstName : t("dashboard.hero.greeting_fallback");
  return (
    <header className="bg-gradient-to-br from-primary-500 to-primary-600 px-6 pb-7 pt-6 text-primary-foreground">
      <h1 className="text-title-1">{t("dashboard.hero.greeting", { name: greetingTarget })}</h1>
      <p className="mt-1 text-body-2 text-primary-foreground/80">{t("dashboard.hero.subtitle")}</p>
      <DashboardStatCards
        activeMembersCount={activeMembersCount}
        todayCollected={todayCollected}
        commissionThisCycle={commissionThisCycle}
      />
    </header>
  );
}
