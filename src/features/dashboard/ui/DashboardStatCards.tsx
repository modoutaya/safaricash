// Story 9.1 / FR34 — the three numeric dashboard stats.
//
// Rendered inside the green DashboardHero as a compact 3-up row of glass
// tiles: white value on top, small uppercase label below. Always a row —
// never stacks — sized to fit a ~320 px hero content width.
//
// 2026-05-24 — the two monetary tiles (Collecté + Commission) are
// masked by default and toggle individually on tap. State is in-memory
// per tile, so navigating away and back to the dashboard re-masks both
// (privacy default: someone glancing at the phone never sees money).
// Active-members count stays static (it's a count, not money).
//
// Pure presentation — the route owns the data hook.
// Visual reference: 03-mockups.html .dash-stats / .dash-stat.

import { useState } from "react";

import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

export interface DashboardStatCardsProps {
  activeMembersCount: number;
  cycleCollected: number;
  commissionThisCycle: number;
}

const MASKED_DISPLAY = "*******";

function StaticStatTile({ label, value }: { label: string; value: string }): JSX.Element {
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

interface MaskedStatTileProps {
  label: string;
  value: string;
  revealAriaKey: TranslationKey;
  hideAriaKey: TranslationKey;
}

function MaskedStatTile({
  label,
  value,
  revealAriaKey,
  hideAriaKey,
}: MaskedStatTileProps): JSX.Element {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRevealed((r) => !r)}
      aria-pressed={revealed}
      aria-label={t(revealed ? hideAriaKey : revealAriaKey)}
      className="flex min-h-[44px] min-w-0 flex-1 flex-col items-center gap-1 rounded-md bg-primary-foreground/15 px-2 py-3 text-center transition-colors hover:bg-primary-foreground/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground"
    >
      <span
        className="text-title-2 text-primary-foreground"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {revealed ? value : MASKED_DISPLAY}
      </span>
      <span className="text-overline uppercase text-primary-foreground/80">{label}</span>
    </button>
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
      <StaticStatTile
        label={t("dashboard.stat.active_members")}
        value={String(activeMembersCount)}
      />
      <MaskedStatTile
        label={t("dashboard.stat.collected")}
        value={formatFcfaAmount(cycleCollected)}
        revealAriaKey="dashboard.stat.collected_reveal_aria"
        hideAriaKey="dashboard.stat.collected_hide_aria"
      />
      <MaskedStatTile
        label={t("dashboard.stat.commission")}
        value={formatFcfaAmount(commissionThisCycle)}
        revealAriaKey="dashboard.stat.commission_reveal_aria"
        hideAriaKey="dashboard.stat.commission_hide_aria"
      />
    </div>
  );
}
