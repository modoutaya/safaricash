// Story 2.4 — Member 360 profile (header + transaction history).
//
// Pure presentation: parent route owns data fetching + navigation.

import { Flag } from "lucide-react";

import { StatusBadge } from "@/components/domain/StatusBadge";
import { DisputeInlineBanner } from "@/features/dispute";
import { useT } from "@/i18n/useT";

import { formatFcfaAmount } from "../api/formatAmount";
import { formatTransactionTime } from "../api/formatTransactionTime";
import { memberInitials } from "../api/memberInitials";
import { transactionIcon } from "../api/transactionIcon";
import { deriveMemberStatus } from "../api/deriveMemberStatus";
import type { CycleRow, MemberRow, MemberStats, TransactionKind, TransactionRow } from "../types";
import { LocalDataNote } from "./LocalDataNote";

export interface MemberProfileProps {
  member: MemberRow;
  currentCycle: CycleRow | null;
  /** Story 2.7 — completed/settled cycles to render as a read-only history. */
  previousCycles?: CycleRow[];
  transactions: TransactionRow[];
  stats: MemberStats;
  /** Story 6.7 — tap a transaction row to open the per-receipt sheet.
   *  When undefined, rows render as non-interactive `<article>` (Story 2.4
   *  default, kept for tests that don't exercise the receipt flow). */
  onTransactionTap?: (tx: TransactionRow) => void;
  /** Story 10.3 — number of OPEN disputes on this member's transactions.
   *  Drives the dispute banner (0 → sr-only, no banner). */
  openDisputeCount?: number;
  /** Story 10.3 — transaction ids that have an open dispute; each such
   *  history row shows a dispute icon. */
  disputedTransactionIds?: ReadonlySet<string>;
  /** Story 10.3 — opens the dispute detail view (banner CTA). */
  onDisputeBannerTap?: () => void;
}

const PREVIOUS_CYCLE_DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function formatPreviousCycleDate(iso: string): string {
  // start_date / end_date are date strings (YYYY-MM-DD), not full ISO; the
  // Date constructor treats them as UTC midnight, which is fine for display.
  return PREVIOUS_CYCLE_DATE_FORMATTER.format(new Date(iso));
}

const KIND_LABEL_KEY: Record<
  TransactionKind,
  | "members.profile.transactions.kind_contribution"
  | "members.profile.transactions.kind_rattrapage"
  | "members.profile.transactions.kind_advance"
> = {
  contribution: "members.profile.transactions.kind_contribution",
  rattrapage: "members.profile.transactions.kind_rattrapage",
  advance: "members.profile.transactions.kind_advance",
};

export function MemberProfile({
  member,
  currentCycle,
  previousCycles = [],
  transactions,
  stats,
  onTransactionTap,
  openDisputeCount = 0,
  disputedTransactionIds,
  onDisputeBannerTap,
}: MemberProfileProps) {
  const t = useT();
  const displayStatus = deriveMemberStatus({ status: member.status }, currentCycle);
  const showStatusBadge = displayStatus !== "hidden";

  // Sort transactions newest-first (Story 2.4 spec Q2 confirmed).
  const sortedTransactions = [...transactions].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  );

  const showAdvancesRow = stats.outstandingAdvances > 0;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 p-4">
      <LocalDataNote />
      <DisputeInlineBanner
        count={openDisputeCount}
        onViewDetail={onDisputeBannerTap ?? (() => {})}
      />
      <section className="flex flex-col gap-4 rounded-lg border border-hairline bg-card p-4">
        <header className="flex items-center gap-3">
          <div
            aria-hidden
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-100 text-title-2 font-semibold text-primary-700"
          >
            {memberInitials(member.name)}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="truncate text-title-1 text-text-primary">{member.name}</h1>
            {member.phone_number ? (
              <p className="truncate text-body-2 text-text-secondary">{member.phone_number}</p>
            ) : null}
          </div>
          {showStatusBadge ? <StatusBadge kind={displayStatus} className="flex-none" /> : null}
        </header>

        <dl
          className="flex flex-col gap-2 text-body-2"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          <div className="flex items-center justify-between">
            <dt className="text-text-secondary">
              {t("members.profile.field.daily_amount", {
                amount: formatFcfaAmount(member.daily_amount),
              })}
            </dt>
          </div>
          {currentCycle ? (
            <div className="flex items-center justify-between">
              <dt className="text-text-secondary">
                {t("members.profile.field.cycle_day", {
                  n: stats.cycleDay,
                  total: stats.cycleLength,
                })}
              </dt>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <dt className="text-text-secondary">
              {t("members.profile.field.contributed_total", {
                amount: formatFcfaAmount(stats.contributedTotal),
              })}
            </dt>
          </div>
          {showAdvancesRow ? (
            <div className="flex items-center justify-between">
              <dt className="text-warning">
                {t("members.profile.field.outstanding_advances", {
                  amount: formatFcfaAmount(stats.outstandingAdvances),
                })}
              </dt>
            </div>
          ) : null}
        </dl>

        {currentCycle ? (
          <p
            className="text-display text-primary-700"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {t("members.profile.field.projected_balance", {
              amount: formatFcfaAmount(stats.projectedFinalBalance),
            })}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="transactions-title">
        <h2 id="transactions-title" className="text-title-2 text-text-primary">
          {t("members.profile.transactions.title")}
        </h2>
        {sortedTransactions.length === 0 ? (
          <p className="rounded-lg border border-hairline bg-card p-4 text-body-2 text-text-secondary">
            {t("members.profile.transactions.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sortedTransactions.map((tx) => {
              const Icon = transactionIcon(tx.kind);
              const isAdvance = tx.kind === "advance";
              const isDisputed = disputedTransactionIds?.has(tx.id) ?? false;
              const amountPrefix = isAdvance ? "−" : "";
              const rowAriaLabel = t("transaction.receipt_sheet.tx_button_label", {
                kind: t(KIND_LABEL_KEY[tx.kind]),
                date: formatTransactionTime(tx.created_at),
                amount: `${amountPrefix}${formatFcfaAmount(tx.amount)}`,
              });
              const interactive = onTransactionTap !== undefined;
              const rowBody = (
                <>
                  <div
                    aria-hidden
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                      isAdvance ? "bg-warning-bg text-warning" : "bg-primary-50 text-primary-700"
                    }`}
                  >
                    <Icon size={20} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="flex items-center gap-1.5 text-body-1 font-medium text-text-primary">
                      <span className="truncate">{t(KIND_LABEL_KEY[tx.kind])}</span>
                      {isDisputed ? (
                        <Flag
                          size={14}
                          className="shrink-0 text-destructive"
                          aria-label={t("dispute.row.icon_label")}
                        />
                      ) : null}
                    </p>
                    <p className="truncate text-body-2 text-text-secondary">
                      {formatTransactionTime(tx.created_at)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <p
                      className={`text-body-1 font-semibold ${
                        isAdvance ? "text-warning" : "text-text-primary"
                      }`}
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {amountPrefix}
                      {formatFcfaAmount(tx.amount)} FCFA
                    </p>
                    <span className="text-caption text-text-secondary">
                      {t("members.profile.transactions.cycle_day_chip", { n: tx.cycle_day })}
                    </span>
                  </div>
                </>
              );
              return (
                <li key={tx.id}>
                  {interactive ? (
                    <button
                      type="button"
                      data-tx-id={tx.id}
                      aria-label={rowAriaLabel}
                      onClick={() => onTransactionTap?.(tx)}
                      className="flex w-full items-center gap-3 rounded-lg border border-hairline bg-card p-3 text-left hover:bg-surface-pressed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                    >
                      {rowBody}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 rounded-lg border border-hairline bg-card p-3">
                      {rowBody}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {previousCycles.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="previous-cycles-title">
          <h2 id="previous-cycles-title" className="text-title-2 text-text-primary">
            {t("members.profile.previous_cycles.title")}
          </h2>
          <ul className="flex flex-col gap-1 rounded-lg border border-hairline bg-card p-3">
            {previousCycles.map((cycle) => (
              <li key={cycle.id} className="text-body-2 text-text-secondary">
                {t("members.profile.previous_cycles.row", {
                  n: cycle.cycle_number,
                  start: formatPreviousCycleDate(cycle.start_date),
                  end: formatPreviousCycleDate(cycle.end_date),
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
