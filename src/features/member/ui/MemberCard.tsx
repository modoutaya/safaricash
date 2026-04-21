// Story 2.1 — dense member row card (name + amount + cycle progress + status).
//
// a11y: 44×44 px minimum touch target (NFR-A2). role="button" when an
// onSelect is provided so screen readers announce it as interactive;
// otherwise a plain <article> (Story 2.1 wires it non-interactive; Story
// 2.4 profile view will flip it to interactive).

import { StatusBadge } from "@/components/domain/StatusBadge";
import { CycleProgressBar } from "@/features/cycle";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

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

  const body = (
    <>
      <div
        aria-hidden="true"
        className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-primary-100 text-body-1 font-semibold text-primary-700"
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
        {member.currentCycle ? (
          <CycleProgressBar dayNumber={member.currentCycle.dayNumber} className="mt-1" />
        ) : null}
      </div>
    </>
  );

  const baseClass = cn(
    "flex min-h-[44px] w-full items-center gap-3 rounded-lg border border-hairline bg-card p-3 text-left",
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
