// Story 12.5 PR E — Awaiting-settlement card.
//
// Surfaces the oldest cycle-awaiting-settlement as a prominent
// warning-coloured card above the MemberProfile identity section. The
// pre-PR-E UI buried this as a single dt row inside the stats dl, which
// pilot feedback (2026-05-21) flagged as easy to miss. The card lays
// out:
//   ⚠ Paiement en attente
//   Cycle clos le {DD/MM/YYYY}
//   {amount} FCFA      (large, primary-700)
//   [ ✓ Payer le membre ] CTA → /members/:id/settlement
//
// Pure presentation: parent route (/members/:id) decides whether to
// render this above the profile based on
// `data.cycleAwaitingSettlement` + `data.awaitingSettlementPayout`.

import { CheckCircle2, AlertCircle } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";

const CYCLE_DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "long",
  year: "numeric",
});

function formatCycleEndDate(iso: string): string {
  // YYYY-MM-DD → UTC midnight (date-only, no TZ ambiguity).
  return CYCLE_DATE_FORMATTER.format(new Date(`${iso}T00:00:00Z`));
}

export interface AwaitingSettlementCardProps {
  payoutAmount: number;
  cycleEndDate: string;
  settleHref: string;
  className?: string;
}

export function AwaitingSettlementCard({
  payoutAmount,
  cycleEndDate,
  settleHref,
  className,
}: AwaitingSettlementCardProps): JSX.Element {
  const t = useT();
  return (
    <section
      aria-labelledby="awaiting-settlement-heading"
      className={`flex flex-col gap-3 rounded-lg border-2 border-warning bg-warning-bg p-4 ${className ?? ""}`}
    >
      <div className="flex items-center gap-2">
        <AlertCircle size={20} className="shrink-0 text-warning" aria-hidden />
        <h2
          id="awaiting-settlement-heading"
          className="text-title-2 font-semibold text-warning-text"
        >
          {t("members.profile.awaiting.title")}
        </h2>
      </div>
      <p className="text-body-2 text-warning-text">
        {t("members.profile.awaiting.cycle_closed_label", {
          date: formatCycleEndDate(cycleEndDate),
        })}
      </p>
      <p
        className="text-display font-bold text-primary-700"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {formatFcfaAmount(payoutAmount)} FCFA
      </p>
      <Button asChild size="lg" className="w-full justify-center gap-2">
        <Link to={settleHref}>
          <CheckCircle2 size={20} aria-hidden />
          {t("members.profile.awaiting.cta")}
        </Link>
      </Button>
    </section>
  );
}
