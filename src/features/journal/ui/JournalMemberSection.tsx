// Story 12.1 — one collapsible section per member. Closed by default;
// expansion triggers the lazy fetch of that member's transactions for the
// selected period (useJournalTransactions, enabled gating).
//
// Implemented with native `<details>` for accessibility (zero JS for
// focus management; screen readers announce expansion automatically) and
// to avoid pulling in a 3rd-party collapsible.

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { resolveJournalPeriodBounds, type JournalPeriod } from "../api/period";
import type { JournalMember } from "../api/useJournalMembers";
import { useJournalTransactions } from "../api/useJournalTransactions";
import { JournalTransactionRow } from "./JournalTransactionRow";

export interface JournalMemberSectionProps {
  member: JournalMember;
  period: JournalPeriod;
}

export function JournalMemberSection({ member, period }: JournalMemberSectionProps): JSX.Element {
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
        ) : query.data && query.data.length > 0 ? (
          <ul className="py-1">
            {query.data.map((tx) => (
              <JournalTransactionRow key={tx.id} tx={tx} />
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
