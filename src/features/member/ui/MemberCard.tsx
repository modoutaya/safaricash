// Story 2.1 — member row card.
//
// Shows, per member: initials avatar, name, status badge, daily amount,
// and — when a cycle is running — the cycle day, any booked advance, the
// progress bar, the days-remaining countdown and the projected final
// payout (Story 3.2 cycle engine). Members with no active cycle render
// the compact top row only.
//
// a11y: 44×44 px minimum touch target (NFR-A2). role="button" when an
// onSelect is provided so screen readers announce it as interactive;
// otherwise a plain <article>. Balance uses primary-700 (not primary-500)
// so 14 px text clears WCAG AA contrast on the white card.
//
// Visual reference: 03-mockups.html .member-card.

import { StatusBadge } from "@/components/domain/StatusBadge";
import { daysUntilCycleEnd } from "@/domain/cycle";
import { CycleProgressBar } from "@/features/cycle";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { formatFcfaAmount } from "../api/formatAmount";
import { memberInitials } from "../api/memberInitials";
import type { MemberWithMeta } from "../types";

export interface MemberCardProps {
  member: MemberWithMeta;
  onSelect?: (memberId: string) => void;
  className?: string;
}

export function MemberCard({ member, onSelect, className }: MemberCardProps): JSX.Element {
  const t = useT();
  const interactive = typeof onSelect === "function";
  const cycle = member.currentCycle;
  const daysRemaining = cycle ? daysUntilCycleEnd(cycle.dayNumber, cycle.cycleLength) : 0;
  // Defensive: a stale persisted cache from before this field existed can
  // surface `undefined`; only render a real, finite number.
  const projectedBalance =
    typeof member.projectedBalance === "number" && Number.isFinite(member.projectedBalance)
      ? member.projectedBalance
      : null;

  const countdownLabel = (): string => {
    if (daysRemaining <= 0) return t("members.card.last_day");
    if (daysRemaining === 1) return t("members.card.days_remaining_one");
    return t("members.card.days_remaining_many", { days: daysRemaining });
  };

  const body = (
    <>
      <div
        aria-hidden="true"
        className="flex h-10 w-10 flex-none items-center justify-center self-start rounded-full bg-primary-100 text-body-1 font-semibold text-primary-700"
      >
        {memberInitials(member.name)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2 className="truncate text-body-1 font-semibold text-text-primary">{member.name}</h2>
          <StatusBadge kind={member.displayStatus} className="flex-none" />
        </div>
        <p
          className="text-body-2 text-text-secondary"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {t("members.amount_per_day", { amount: formatFcfaAmount(member.dailyAmount) })}
        </p>
        {cycle ? (
          <>
            <p
              className="text-caption text-text-secondary"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {t("members.card.cycle_day", { day: cycle.dayNumber })}
              {member.cycleAdvancesTotal > 0
                ? ` • ${t("members.card.advance_inline", {
                    amount: formatFcfaAmount(member.cycleAdvancesTotal),
                  })}`
                : ""}
            </p>
            <CycleProgressBar dayNumber={cycle.dayNumber} className="mt-1" />
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-caption font-medium text-primary-700">
                {countdownLabel()}
              </span>
              {projectedBalance !== null ? (
                <span
                  className="flex-none text-body-2 font-semibold text-primary-700"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                  aria-label={t("members.card.balance_aria", {
                    amount: formatFcfaAmount(projectedBalance),
                  })}
                >
                  {t("members.card.balance_value", {
                    amount: formatFcfaAmount(projectedBalance),
                  })}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );

  const baseClass = cn(
    "flex min-h-[44px] w-full items-start gap-3 rounded-lg border border-hairline bg-card p-3 text-left",
    className,
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={() => onSelect!(member.id)}
        className={cn(
          baseClass,
          "transition-colors hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        data-member-id={member.id}
      >
        {body}
      </button>
    );
  }

  return (
    <article className={baseClass} data-member-id={member.id}>
      {body}
    </article>
  );
}
