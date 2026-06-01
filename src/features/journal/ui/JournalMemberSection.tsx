// Story 12.1 — one collapsible section per member. Closed by default;
// expansion triggers the lazy fetch of that member's transactions for the
// selected period (useJournalTransactions, enabled gating).
//
// Story 12.2 — render a calendar view: one row per applicable cycle-day,
// `missing` rows for days without a contribution (warning marker), and
// rattrapage rows that absorb their forward-covered days. The legacy
// "one row per transaction" shape was replaced by DayRow[] from
// buildJournalDayRows.
//
// Implemented with native `<details>` for accessibility (zero JS for
// focus management; screen readers announce expansion automatically) and
// to avoid pulling in a 3rd-party collapsible.

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { buildJournalDayRows } from "../api/buildJournalDayRows";
import { resolveJournalPeriodBounds, type JournalPeriod } from "../api/period";
import type { JournalMember } from "../api/useJournalMembers";
import { useJournalTransactions } from "../api/useJournalTransactions";
import { JournalDayRow } from "./JournalDayRow";

export interface JournalMemberSectionProps {
  member: JournalMember;
  period: JournalPeriod;
  /** Pinnable "today" — defaults to `new Date()`. Tests pass an explicit
   *  date so the calendar output is deterministic. */
  now?: Date;
}

export function JournalMemberSection({
  member,
  period,
  now,
}: JournalMemberSectionProps): JSX.Element {
  // The lazy-fetch gate. Flips on first expand and stays true so toggling
  // closed→open→closed doesn't refetch (TanStack Query's cache also covers
  // this, but `enabled` removes the request entirely on first close).
  const [hasEverOpened, setHasEverOpened] = useState(false);
  const t = useT();

  const bounds = resolveJournalPeriodBounds(period, member);
  const query = useJournalTransactions({
    memberId: member.id,
    period,
    bounds,
    enabled: hasEverOpened,
  });

  const todayIso = useMemo(() => (now ?? new Date()).toISOString().slice(0, 10), [now]);
  const dayRows = useMemo(() => {
    if (!query.data) return [];
    return buildJournalDayRows({
      transactions: query.data,
      period,
      member,
      todayIso,
    });
  }, [query.data, period, member, todayIso]);

  return (
    <details
      className="group rounded-lg border border-hairline bg-card"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) setHasEverOpened(true);
      }}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-body-1 font-medium text-text-primary">
          {member.name}
        </span>
        <ChevronDown
          aria-hidden
          className="h-5 w-5 flex-none text-text-secondary transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-hairline px-4">
        {bounds === null ? (
          <p className="py-4 text-body-2 text-text-secondary">
            {t("journal.empty_no_previous_cycle")}
          </p>
        ) : query.isLoading ? (
          <p className="py-4 text-body-2 text-text-secondary">
            {t("journal.loading_transactions")}
          </p>
        ) : query.error ? (
          <p className="py-4 text-body-2 text-warning-text">{t("journal.error_transactions")}</p>
        ) : dayRows.length > 0 ? (
          <ul className="py-1">
            {dayRows.map((row) => (
              <JournalDayRow
                key={row.tx ? row.tx.id : `${row.cycleId}#${row.cycleDay}-missing`}
                row={row}
              />
            ))}
          </ul>
        ) : (
          <p className="py-4 text-body-2 text-text-secondary">
            {t("journal.empty_no_transactions")}
          </p>
        )}
      </div>
    </details>
  );
}
