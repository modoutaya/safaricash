// Story 2.4 — Member 360 profile (header + transaction history).
//
// Pure presentation: parent route owns data fetching + navigation.

import { StatusBadge } from "@/components/domain/StatusBadge";
import { useT } from "@/i18n/useT";

import { formatFcfaAmount } from "../api/formatAmount";
import { formatTransactionTime } from "../api/formatTransactionTime";
import { memberInitials } from "../api/memberInitials";
import { transactionIcon } from "../api/transactionIcon";
import { deriveMemberStatus } from "../api/deriveMemberStatus";
import type { CycleRow, MemberRow, MemberStats, TransactionKind, TransactionRow } from "../types";

export interface MemberProfileProps {
  member: MemberRow;
  currentCycle: CycleRow | null;
  transactions: TransactionRow[];
  stats: MemberStats;
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

export function MemberProfile({ member, currentCycle, transactions, stats }: MemberProfileProps) {
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
                {t("members.profile.field.cycle_day", { n: stats.cycleDay })}
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
              const amountPrefix = isAdvance ? "−" : "";
              return (
                <li
                  key={tx.id}
                  className="flex items-center gap-3 rounded-lg border border-hairline bg-card p-3"
                >
                  <div
                    aria-hidden
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                      isAdvance ? "bg-warning-bg text-warning" : "bg-primary-50 text-primary-700"
                    }`}
                  >
                    <Icon size={20} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="truncate text-body-1 font-medium text-text-primary">
                      {t(KIND_LABEL_KEY[tx.kind])}
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
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
