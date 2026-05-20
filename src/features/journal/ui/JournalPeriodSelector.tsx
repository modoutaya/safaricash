// Story 12.1 — segmented control for the Journal period filter.
// Three exclusive options: "Cycle précédent" (default), "Cycle en cours",
// "2 derniers jours". Implemented as a row of pill-buttons with the
// active option carrying primary-500 background.

import type { TranslationKey } from "@/i18n/keys";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { JOURNAL_PERIODS, type JournalPeriod } from "../api/period";

const LABEL_KEY: Record<JournalPeriod, TranslationKey> = {
  cycle_previous: "journal.period.previous_cycle",
  cycle_current: "journal.period.current_cycle",
  last_two_days: "journal.period.last_two_days",
};

export interface JournalPeriodSelectorProps {
  value: JournalPeriod;
  onChange: (next: JournalPeriod) => void;
}

export function JournalPeriodSelector({
  value,
  onChange,
}: JournalPeriodSelectorProps): JSX.Element {
  const t = useT();
  return (
    <div
      role="radiogroup"
      aria-label={t("journal.period_aria_label")}
      className="flex w-full gap-2 overflow-x-auto pb-1"
    >
      {JOURNAL_PERIODS.map((period) => {
        const active = period === value;
        return (
          <button
            key={period}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(period)}
            className={cn(
              "min-w-fit shrink-0 rounded-full border px-4 py-2 text-body-2 font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-primary-500 bg-primary-500 text-white"
                : "border-hairline bg-card text-text-primary",
            )}
          >
            {t(LABEL_KEY[period])}
          </button>
        );
      })}
    </div>
  );
}
