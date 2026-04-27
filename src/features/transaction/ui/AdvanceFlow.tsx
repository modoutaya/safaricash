// Story 5.2 / FR24 — AdvanceFlow screen for /members/:id/advance.
//
// Hosts the situation-in-context panel + suggested-amount chips +
// free-form numeric input + Story 5.1's <AdvanceSimulationPanel>.
// Owns local state for the candidate amount; data comes from
// useMemberProfile (Story 2.4 cache).
//
// Story 5.2 ships the SHELL — onConfirm is optional + the route
// component does NOT pass it yet. Story 5.3 enables-when-valid (motive
// + saver ack), Story 5.4 wires the commit handler.
//
// See: epics.md:905-918 (Story 5.2 BDD), prd.md (FR24),
// ux-design-specification.md:793-823 (Flow 2 mermaid),
// ux-design-specification.md:511 (Informational palette).

import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";

import { AdvanceSimulationPanel } from "@/components/domain/AdvanceSimulationPanel";
import { Button } from "@/components/ui/button";
import { CYCLE_TOTAL_DAYS, isCycleClosedForTransactions } from "@/domain/cycle";
import { useMemberProfile } from "@/features/member";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { ADVANCE_SUGGESTED_AMOUNTS } from "../api/advanceConstants";

/** Story 5.3 will populate this payload via onConfirm; Story 5.4 will
 *  wire the commit handler at the route layer. Exporting now so 5.3's
 *  CTA gate logic can refer to a stable shape. */
export interface AdvanceConfirmPayload {
  amount: number;
}

export interface AdvanceFlowProps {
  memberId: string;
  /** Optional confirmation handler. Story 5.2's route does NOT pass this
   *  yet — the CTA renders disabled. Story 5.3 will gate enable on
   *  motive + saver acknowledgment; Story 5.4 will pass the handler. */
  onConfirm?: (payload: AdvanceConfirmPayload) => void;
}

export function AdvanceFlow({ memberId, onConfirm }: AdvanceFlowProps): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const profileQuery = useMemberProfile(memberId);

  // String state preserves partial typing (typing "5" should not coerce
  // to "5" forever blocking "5", "50", "500"). The derived integer
  // candidateAmount is what the simulation panel consumes.
  const [rawAmount, setRawAmount] = useState("");
  const candidateAmount = useMemo(() => {
    const n = Number.parseInt(rawAmount, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [rawAmount]);

  const data = profileQuery.data;

  // Memoise the array of existing-advance amounts so the simulation
  // panel's identity stays stable across re-renders unrelated to
  // transactions.
  const existingAdvanceAmounts = useMemo(
    () => (data?.transactions ?? []).filter((tx) => tx.kind === "advance").map((tx) => tx.amount),
    [data?.transactions],
  );

  // Loading + error gates come first.
  if (profileQuery.isLoading) {
    return <></>;
  }
  if (profileQuery.isError || data === undefined) {
    return (
      <section
        role="alert"
        aria-live="polite"
        className="mx-auto flex w-full max-w-md flex-col gap-4 p-4"
      >
        <p className="text-body-1 text-destructive">{t("advance.flow.error.load")}</p>
        <Button asChild variant="outline">
          <Link to={`/members/${memberId}`}>{t("advance.flow.back_label")}</Link>
        </Button>
      </section>
    );
  }

  // Defensive redirect: closed cycle / no active cycle. The
  // MemberActionSheet's secondary "Prêt" link is supposed to be disabled
  // in those cases, but a direct URL hit must not yield a working flow
  // that can't commit.
  if (data.currentCycle === null || isCycleClosedForTransactions(data.currentCycle)) {
    return <Navigate to={`/members/${memberId}`} replace />;
  }

  const handleChipTap = (n: number) => setRawAmount(String(n));
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onConfirm) return;
    onConfirm({ amount: candidateAmount });
  };

  const canAcceptCheck = (n: number): boolean => {
    // Mirror canAcceptAdvance's check inline so the chip can reflect
    // capacity without double-importing.
    const total = existingAdvanceAmounts.reduce((a, b) => a + b, 0) + n;
    return total <= data.member.daily_amount * (CYCLE_TOTAL_DAYS - 1);
  };

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate(`/members/${memberId}`)}
          aria-label={t("advance.flow.back_label")}
          className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
        >
          <ChevronLeft size={24} aria-hidden />
        </button>
        <h1 className="text-title-1 text-text-primary">{t("advance.flow.title")}</h1>
      </header>

      {/* Situation-in-context — the present (cycle day / contributed / advances). */}
      <div className="flex flex-col gap-2 rounded-md border border-info-accent/40 bg-info-bg p-3 text-info-text">
        <p className="text-body-2 font-semibold">{t("advance.flow.situation.title")}</p>
        <p className="text-body-2">
          {t("advance.flow.situation.cycle_day", { day: data.stats.cycleDay })}
        </p>
        <p className="text-body-2">
          {t("advance.flow.situation.contributed", {
            amount: formatFcfaAmount(data.stats.contributedTotal),
          })}
        </p>
        <p className="text-body-2">
          {t("advance.flow.situation.advances", {
            amount: formatFcfaAmount(data.stats.outstandingAdvances),
          })}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Suggested-amount chips. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-2 text-text-secondary">
            {t("advance.flow.suggested_label")}
          </legend>
          <div role="group" className="flex flex-wrap gap-2">
            {ADVANCE_SUGGESTED_AMOUNTS.map((n) => {
              const active = candidateAmount === n;
              const disabled = !canAcceptCheck(n);
              return (
                <button
                  key={n}
                  type="button"
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => handleChipTap(n)}
                  className={cn(
                    "min-h-[44px] rounded-full border px-4 text-body-2 font-medium transition-colors",
                    disabled
                      ? "border-hairline bg-card text-text-tertiary"
                      : active
                        ? "border-primary-500 bg-primary-500 text-primary-foreground"
                        : "border-hairline bg-card text-text-primary hover:bg-primary-50",
                  )}
                >
                  {formatFcfaAmount(n)} FCFA
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Free-form numeric input. */}
        <div className="flex flex-col gap-1">
          <label htmlFor="advance-amount" className="text-body-2 text-text-secondary">
            {t("advance.flow.amount_input.label")}
          </label>
          <input
            id="advance-amount"
            type="number"
            inputMode="numeric"
            min={0}
            step={100}
            value={rawAmount}
            onChange={(e) => setRawAmount(e.target.value)}
            className="w-full rounded-md border border-hairline bg-card px-4 py-3 text-body-1 text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-body-2 text-text-secondary">{t("advance.flow.amount_input.helper")}</p>
        </div>

        {/* Story 5.1 simulation panel — consumes the candidate amount. */}
        <AdvanceSimulationPanel
          dailyAmount={data.member.daily_amount}
          existingAdvances={existingAdvanceAmounts}
          candidateAmount={candidateAmount}
        />

        {/* Disabled CTA — Story 5.3 enables-when-valid; Story 5.4 commits. */}
        <Button
          type="submit"
          size="lg"
          disabled
          title={t("advance.flow.cta_disabled_tooltip")}
          aria-describedby="advance-cta-help"
        >
          {t("advance.flow.cta_grant")}
        </Button>
        <span id="advance-cta-help" className="sr-only">
          {t("advance.flow.cta_disabled_tooltip")}
        </span>
      </form>
    </section>
  );
}
