// Story 12.1 — single transaction row inside a JournalMemberSection.
// Renders the date+time, a kind chip (Cotisation / Avance / Rattrapage /
// Règlement), and the amount in FCFA.
//
// Settlement transactions appear here when they fall in the selected
// period — Story 7.4 stamps them as `kind='settlement'` rows.

import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { formatTransactionTime } from "@/features/member/api/formatTransactionTime";
import type { TranslationKey } from "@/i18n/keys";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import type { JournalTransaction } from "../api/useJournalTransactions";

const KIND_LABEL_KEY: Record<JournalTransaction["kind"], TranslationKey> = {
  contribution: "journal.kind_contribution",
  rattrapage: "journal.kind_rattrapage",
  advance: "journal.kind_advance",
};

const KIND_CHIP_CLASS: Record<JournalTransaction["kind"], string> = {
  contribution: "bg-primary-100 text-primary-700",
  rattrapage: "bg-primary-100 text-primary-700",
  advance: "bg-warning-bg text-warning-text",
};

export interface JournalTransactionRowProps {
  tx: JournalTransaction;
}

export function JournalTransactionRow({ tx }: JournalTransactionRowProps): JSX.Element {
  const t = useT();
  return (
    <li className="flex items-center justify-between gap-3 border-t border-hairline py-3 first:border-t-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-caption text-text-secondary">
          {formatTransactionTime(tx.createdAt)}
        </span>
        <span
          className={cn(
            "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-overline font-medium",
            KIND_CHIP_CLASS[tx.kind],
          )}
        >
          {t(KIND_LABEL_KEY[tx.kind])}
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
