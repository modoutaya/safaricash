// Story 12.2 — single row in the JournalMemberSection's calendar list.
// Renders one of four variants: contribution / rattrapage / advance / missing.
//
// Replaces the simpler JournalTransactionRow from Story 12.1, which was a
// thin wrapper around one transaction; this row takes a `DayRow` so it
// can render the `missing` variant (no underlying tx, warning visual) and
// the `rattrapage` variant with a "· N jours" suffix on the chip.

import { AlertTriangle } from "lucide-react";

import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { formatTransactionTime } from "@/features/member/api/formatTransactionTime";
import type { TranslationKey } from "@/i18n/keys";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import type { DayRow } from "../api/buildJournalDayRows";

const TRANSACTION_KIND_LABEL_KEY: Record<
  "contribution" | "rattrapage" | "advance",
  TranslationKey
> = {
  contribution: "journal.kind_contribution",
  rattrapage: "journal.kind_rattrapage",
  advance: "journal.kind_advance",
};

const TRANSACTION_KIND_CHIP_CLASS: Record<"contribution" | "rattrapage" | "advance", string> = {
  contribution: "bg-primary-100 text-primary-700",
  rattrapage: "bg-primary-100 text-primary-700",
  advance: "bg-warning-bg text-warning-text",
};

/** YYYY-MM-DD → "lun. 12 mai" (no time). Used for missing-day rows
 *  where no transaction timestamp is available. */
const dateOnlyFormatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

function formatDateOnly(isoDate: string): string {
  return dateOnlyFormatter.format(new Date(`${isoDate}T00:00:00Z`));
}

export interface JournalDayRowProps {
  row: DayRow;
}

export function JournalDayRow({ row }: JournalDayRowProps): JSX.Element {
  if (row.kind === "missing") {
    return <MissingDayRow row={row} />;
  }
  return <TransactionDayRow row={row} />;
}

function TransactionDayRow({ row }: { row: DayRow }): JSX.Element {
  const t = useT();
  const tx = row.tx;
  // row.tx is guaranteed present for non-missing kinds by buildJournalDayRows.
  if (!tx) return <></>;
  const transactionKind = row.kind as "contribution" | "rattrapage" | "advance";
  const labelKey = TRANSACTION_KIND_LABEL_KEY[transactionKind];
  const chipClass = TRANSACTION_KIND_CHIP_CLASS[transactionKind];
  // Rattrapage with daysCovered > 1 → append "· N jours" to the chip.
  const showDaysSuffix =
    row.kind === "rattrapage" && row.daysCovered !== undefined && row.daysCovered > 1;

  return (
    <li className="flex items-center justify-between gap-3 border-t border-hairline py-3 first:border-t-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-caption text-text-secondary">
          {formatTransactionTime(tx.createdAt)}
        </span>
        <span
          className={cn(
            "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-overline font-medium",
            chipClass,
          )}
        >
          {t(labelKey)}
          {showDaysSuffix
            ? ` ${t("journal.kind_rattrapage_days_suffix", { n: row.daysCovered ?? 0 })}`
            : ""}
        </span>
      </div>
      <span
        className="text-body-1 font-semibold text-text-primary"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {formatFcfaAmount(tx.amount)} F CFA
      </span>
    </li>
  );
}

function MissingDayRow({ row }: { row: DayRow }): JSX.Element {
  const t = useT();
  return (
    <li
      className="flex items-center gap-3 border-t border-hairline py-3 first:border-t-0"
      aria-label={t("journal.day_missing_headline")}
    >
      <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-warning-bg">
        <AlertTriangle aria-hidden className="h-5 w-5 text-warning-text" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-caption text-text-secondary">{formatDateOnly(row.date)}</span>
        <span className="text-body-2 font-medium text-warning-text">
          {t("journal.day_missing_headline")}
        </span>
      </div>
    </li>
  );
}
