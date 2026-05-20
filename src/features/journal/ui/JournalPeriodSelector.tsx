// Story 12.1 — segmented control for the Journal period filter.
// Three exclusive options: "Cycle précédent" (default), "Cycle en cours",
// "2 derniers jours". Implemented as a row of pill-buttons with the
// active option carrying primary-700 background (white-on-primary-700
// clears WCAG AA 4.5:1 — primary-500 was only 3.38:1).

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
              // Active state uses primary-700 (not primary-500) to clear the
              // WCAG AA 4.5:1 contrast ratio with text-primary-foreground.
              // primary-500 + white was only 3.38:1 (axe-flagged 2026-05-20).
              active
                ? "border-primary-700 bg-primary-700 text-primary-foreground"
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
