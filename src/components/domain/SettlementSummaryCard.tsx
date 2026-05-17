// Story 7.1 / FR21 — settlement summary card (epics.md:1098-1105). Pure
// presentation atom for the ceremony surface: caller owns state, network,
// re-auth. Final payout MUST come from settle() in @/domain/cycle (Story
// 3.2) — NFR-R3 zero-tolerance vs. in-cycle SMS projections.

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { commission, settle } from "@/domain/cycle";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { memberInitials } from "@/features/member/api/memberInitials";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

export interface SettlementSummaryCardProps {
  memberId: string;
  memberName: string;
  dailyAmount: number;
  /** Sum of contribution + rattrapage amounts captured for THIS cycle. */
  contributedTotal: number;
  /** FCFA integer per booked advance. Order = caller's display order. */
  advances: ReadonlyArray<number>;
  cycleId: string;
  /** ISO date string YYYY-MM-DD. */
  cycleStartDate: string;
  /** ISO date string YYYY-MM-DD. */
  cycleEndDate: string;
  /** When true, both CTAs are disabled and the primary shows the submitting spinner. */
  isSubmitting?: boolean;
  onVerifyTransactions: (memberId: string, cycleId: string) => void;
  onConfirm: (memberId: string, cycleId: string) => void;
  className?: string;
}

// Module-scope `Intl.DateTimeFormat` — same pattern as MemberProfile.tsx
// PREVIOUS_CYCLE_DATE_FORMATTER (Story 2.4). Constructing once avoids the
// per-render allocation hit.
const CYCLE_DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function formatCycleDate(iso: string): string {
  return CYCLE_DATE_FORMATTER.format(new Date(`${iso}T00:00:00Z`));
}

function sumAdvances(advances: ReadonlyArray<number>): number {
  let total = 0;
  for (const a of advances) total += a;
  return total;
}

export function SettlementSummaryCard({
  memberId,
  memberName,
  dailyAmount,
  contributedTotal,
  advances,
  cycleId,
  cycleStartDate,
  cycleEndDate,
  isSubmitting = false,
  onVerifyTransactions,
  onConfirm,
  className,
}: SettlementSummaryCardProps): JSX.Element {
  const t = useT();
  const firstName = memberName.split(" ")[0] ?? memberName;
  const commissionAmount = commission(dailyAmount);
  const advancesSum = sumAdvances(advances);
  const finalPayout = settle(dailyAmount, advances);
  const hasAdvances = advances.length > 0;
  const showAdvancesSubList = advances.length > 1;

  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-md border border-primary-200 bg-card p-4",
        className,
      )}
    >
      {/* Header — avatar + name + cycle range. */}
      <header className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary-100 text-title-2 font-semibold text-primary-700"
        >
          {memberInitials(memberName)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="truncate text-title-1 text-text-primary">{memberName}</h2>
          <p className="truncate text-body-2 text-text-secondary">
            {t("settlement.summary.cycle_range", {
              start: formatCycleDate(cycleStartDate),
              end: formatCycleDate(cycleEndDate),
            })}
          </p>
        </div>
      </header>

      {/* 4-row body. */}
      <div className="flex flex-col gap-2">
        {/* Row 1 — contributions (positive). */}
        <div className="flex items-baseline justify-between">
          <span className="text-body-2 text-text-secondary">
            {t("settlement.summary.row_contributions")}
          </span>
          <span
            className="text-body-1 text-text-primary"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {formatFcfaAmount(contributedTotal)} FCFA
          </span>
        </div>

        {/* Row 2 — commission (deduction). */}
        <div className="flex items-baseline justify-between">
          <span className="text-body-2 text-text-secondary">
            {t("settlement.summary.row_commission")}
          </span>
          <span
            className="text-body-1 text-text-secondary"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            − {formatFcfaAmount(commissionAmount)} FCFA
          </span>
        </div>

        {/* Row 3 — advances (deduction). */}
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <span className="text-body-2 text-text-secondary">
              {hasAdvances
                ? t("settlement.summary.row_advances_label")
                : t("settlement.summary.row_advances_none")}
            </span>
            <span
              className="text-body-1 text-text-secondary"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {hasAdvances
                ? `− ${formatFcfaAmount(advancesSum)} FCFA`
                : `${formatFcfaAmount(0)} FCFA`}
            </span>
          </div>
          {showAdvancesSubList ? (
            <ul className="flex flex-col gap-0.5 pl-2">
              {advances.map((amount, index) => (
                <li
                  key={`${index}-${amount}`}
                  className="text-body-2 text-text-secondary"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {t("settlement.summary.advances_detail_item", {
                    n: index + 1,
                    amount: formatFcfaAmount(amount),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* Row 4 — final payout (large, primary, aria-live). */}
        <div
          aria-live="polite"
          className="mt-1 flex flex-col gap-1 border-t border-primary-100 pt-2"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-body-1 font-semibold text-text-primary">
              {t("settlement.summary.row_final_payout")}
            </span>
            <span
              className="shrink-0 text-amount-large font-semibold text-primary"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {formatFcfaAmount(finalPayout)} FCFA
            </span>
          </div>
          <p className="text-body-2 text-text-secondary">
            {t("settlement.summary.payout_subtitle", { memberFirstName: firstName })}
          </p>
        </div>
      </div>

      {/* CTA block. */}
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          className="w-full"
          disabled={isSubmitting}
          onClick={() => onVerifyTransactions(memberId, cycleId)}
        >
          {t("settlement.summary.cta_verify")}
        </Button>
        <Button
          className="w-full"
          disabled={isSubmitting}
          onClick={() => onConfirm(memberId, cycleId)}
        >
          {isSubmitting ? (
            <>
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              {t("settlement.summary.cta_submitting")}
            </>
          ) : (
            t("settlement.summary.cta_confirm")
          )}
        </Button>
      </div>
    </section>
  );
}
