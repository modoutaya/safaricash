// Story 9.1 — dashboard quick actions.
//
// Two shortcuts to start a transaction. The app records contributions and
// advances per-member, so both shortcuts funnel through the members list
// (the member picker): the collector taps a member, then records. The
// "Prêt Express" shortcut carries `?intent=advance` so the member tap
// lands on the advance page instead of the default transaction page.
//
// Visual reference: 03-mockups.html .quick-actions.

import { Coins, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";

export function DashboardQuickActions(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  return (
    <div
      role="group"
      aria-label={t("dashboard.quick_actions.label")}
      className="grid grid-cols-2 gap-3"
    >
      <Button type="button" className="w-full" onClick={() => navigate("/members")}>
        <Coins aria-hidden className="h-4 w-4 shrink-0" />
        {t("dashboard.quick_actions.contribution")}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => navigate("/members?intent=advance")}
      >
        <Zap aria-hidden className="h-4 w-4 shrink-0" />
        {t("dashboard.quick_actions.advance")}
      </Button>
    </div>
  );
}
