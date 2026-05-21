// Story 5.2-5.4 + Story 4.6 redesign — AdvanceFlow ("Prêt Express").
//
// Faithful to 03-mockups.html "Prêt Express": a white "Sélection du
// membre" card holding a member <select>, the blue "Situation actuelle"
// box, the currency-suffixed amount input and the "Montants suggérés"
// grid; then the green "Impact sur le solde final" preview-card, the
// amber "Vérification importante" box, the (optional) motive input and
// the submit button.
//
// The member <select> is functional — switching re-navigates to that
// member's advance page (onSelectMember). The green topbar uses
// primary-700 so the white text clears WCAG AA (the axe E2E gates this).
//
// See: epics.md:905-918 (Story 5.2 BDD), prd.md (FR24),
// supabase/migrations/20260518000001 (motive made optional).

import { ArrowLeft, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";

import { AdvanceSimulationPanel } from "@/components/domain/AdvanceSimulationPanel";
import { Button } from "@/components/ui/button";
import { canAcceptAdvance, cycleLengthDays, isCycleClosedForTransactions } from "@/domain/cycle";
import { useMemberProfile } from "@/features/member";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { ADVANCE_SUGGESTED_AMOUNTS } from "../api/advanceConstants";

/** Story 5.4 — payload consumed by the route's onConfirm handler. */
export interface AdvanceConfirmPayload {
  amount: number;
  motive: string;
}

export interface AdvanceFlowMemberOption {
  id: string;
  name: string;
  /** FCFA integer — the member's daily contribution. */
  dailyAmount: number;
}

export interface AdvanceFlowProps {
  memberId: string;
  /** Members eligible for an advance — populates the member <select>. */
  members: ReadonlyArray<AdvanceFlowMemberOption>;
  onSelectMember: (memberId: string) => void;
  /** Optional confirmation handler — Story 5.4 wires it at the route. */
  onConfirm?: (payload: AdvanceConfirmPayload) => void;
}

const SELECT_CLASS =
  "h-11 w-full appearance-none rounded-md border border-hairline bg-surface-1 pl-3 pr-9 " +
  "text-body-1 text-text-primary focus-visible:outline-none focus-visible:border-primary " +
  "focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export function AdvanceFlow({
  memberId,
  members,
  onSelectMember,
  onConfirm,
}: AdvanceFlowProps): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const profileQuery = useMemberProfile(memberId);

  // String state preserves partial typing; the derived integer is what
  // the simulation panel consumes.
  const [rawAmount, setRawAmount] = useState("");
  const candidateAmount = useMemo(() => {
    const n = Number.parseInt(rawAmount, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [rawAmount]);

  // Story 4.6 — motive is now optional (mockup parity); kept for the
  // audit payload but no longer gates the CTA.
  const [motive, setMotive] = useState("");

  const data = profileQuery.data;

  const existingAdvanceAmounts = useMemo(
    () => (data?.transactions ?? []).filter((tx) => tx.kind === "advance").map((tx) => tx.amount),
    [data?.transactions],
  );

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

  // Defensive redirect: closed / no active cycle — a direct URL hit must
  // not yield a flow that can't commit.
  if (data.currentCycle === null || isCycleClosedForTransactions(data.currentCycle)) {
    return <Navigate to={`/members/${memberId}`} replace />;
  }

  const handleChipTap = (n: number) => setRawAmount(String(n));

  // Story 12.5 PR B — capacity bounded by ACTUAL contributedTotal.
  // The collector never advances more than what's been versed so far.
  const canAcceptCheck = (n: number): boolean =>
    canAcceptAdvance(data.stats.contributedTotal, existingAdvanceAmounts, n);
  // Simulation panel still needs cycleLength for its row-1 totalProjected
  // display + openingBalance for the projected-balance display. PR C
  // collapses those props as it renames projected → currentBalance.
  const cycleLength = cycleLengthDays(data.currentCycle.start_date, data.currentCycle.end_date);
  const openingBalance = data.stats.openingBalance;

  const trimmedMotive = motive.trim();
  const ctaEnabled = candidateAmount > 0 && canAcceptCheck(candidateAmount);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ctaEnabled || !onConfirm) return;
    onConfirm({ amount: candidateAmount, motive: trimmedMotive });
  };

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col">
      {/* Full-bleed green topbar — primary-700 keeps white text AA-safe. */}
      <header className="flex flex-col gap-1 bg-primary-700 px-4 pb-6 pt-4 text-primary-foreground">
        <button
          type="button"
          onClick={() => navigate(`/members/${memberId}`)}
          className="-ml-1 inline-flex w-fit items-center gap-1 rounded-md py-1 pl-1 pr-2 text-body-2 text-primary-foreground/90 hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground"
        >
          <ArrowLeft aria-hidden className="h-4 w-4 shrink-0" />
          {t("advance.flow.back_label")}
        </button>
        <h1 className="text-title-1">{t("advance.flow.title")}</h1>
        <p className="text-body-2 text-primary-foreground/90">{t("advance.flow.subtitle")}</p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-4">
        {/* White "Sélection du membre" card. */}
        <div className="flex flex-col gap-4 rounded-lg border border-hairline bg-card p-5">
          <h2 className="text-title-2 text-primary-700">{t("advance.flow.form_title")}</h2>

          {/* Member selector — switching re-navigates to that member. */}
          <div className="flex flex-col gap-2">
            <label htmlFor="advance-member" className="text-caption font-semibold text-primary-700">
              {t("advance.flow.member_label")}
            </label>
            <div className="relative">
              <select
                id="advance-member"
                value={memberId}
                onChange={(e) => onSelectMember(e.target.value)}
                className={SELECT_CLASS}
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {t("advance.flow.member_option", {
                      name: m.name,
                      amount: formatFcfaAmount(m.dailyAmount),
                    })}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary-500"
              />
            </div>
          </div>

          {/* Situation-in-context — blue informational box. */}
          <div className="flex flex-col gap-2 rounded-md border border-info-accent bg-info-bg p-4 text-info-text">
            <p className="text-body-2 font-semibold">{t("advance.flow.situation.title")}</p>
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption">{t("advance.flow.situation.day_label")}</span>
              <span className="text-caption font-semibold">
                {t("advance.flow.situation.day_value", {
                  day: data.stats.cycleDay,
                  total: data.stats.cycleLength,
                })}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption">{t("advance.flow.situation.contributed_label")}</span>
              <span
                className="text-caption font-semibold"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {t("advance.flow.situation.amount_value", {
                  amount: formatFcfaAmount(data.stats.contributedTotal),
                })}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption">{t("advance.flow.situation.advances_label")}</span>
              <span
                className="text-caption font-semibold"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {t("advance.flow.situation.amount_value", {
                  amount: formatFcfaAmount(data.stats.outstandingAdvances),
                })}
              </span>
            </div>
          </div>

          {/* Amount input with an inline FCFA suffix. */}
          <div className="flex flex-col gap-2">
            <label htmlFor="advance-amount" className="text-caption font-semibold text-primary-700">
              {t("advance.flow.amount_input.label")}
            </label>
            <div className="relative">
              <input
                id="advance-amount"
                type="number"
                inputMode="numeric"
                min={0}
                step={100}
                value={rawAmount}
                onChange={(e) => setRawAmount(e.target.value)}
                className="h-11 w-full rounded-md border border-hairline bg-surface-1 pl-3 pr-14 text-body-1 text-text-primary focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-caption font-semibold text-primary-700"
              >
                {t("advance.flow.amount_input.currency")}
              </span>
            </div>
          </div>

          {/* Suggested-amount grid. */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-caption font-semibold text-primary-700">
              {t("advance.flow.suggested_label")}
            </legend>
            <div role="group" className="grid grid-cols-3 gap-2">
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
                      "min-h-[44px] rounded-sm border text-caption font-semibold transition-colors",
                      disabled
                        ? "border-hairline bg-card text-text-tertiary"
                        : active
                          ? "border-primary-700 bg-primary-700 text-primary-foreground"
                          : "border-primary-500 bg-primary-100 text-primary-700 hover:bg-primary-200",
                    )}
                  >
                    {t("advance.flow.suggested_chip", { k: n / 1000 })}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        {/* Story 5.1 simulation — green "Impact sur le solde final" card. */}
        <AdvanceSimulationPanel
          dailyAmount={data.member.daily_amount}
          contributedTotal={data.stats.contributedTotal}
          existingAdvances={existingAdvanceAmounts}
          candidateAmount={candidateAmount}
          cycleLength={cycleLength}
          openingBalance={openingBalance}
        />

        {/* Amber security notice. */}
        <div className="flex flex-col gap-1 rounded-md border border-warning bg-warning-bg p-3 text-warning-text">
          <p className="text-caption font-semibold">{t("advance.flow.warning.title")}</p>
          <p className="text-body-2">{t("advance.flow.warning.body")}</p>
        </div>

        {/* Motive — optional free text (Story 4.6). */}
        <div className="flex flex-col gap-2">
          <label htmlFor="advance-motive" className="text-caption font-semibold text-primary-700">
            {t("advance.flow.motive.label")}
          </label>
          <input
            id="advance-motive"
            type="text"
            maxLength={280}
            value={motive}
            onChange={(e) => setMotive(e.target.value)}
            placeholder={t("advance.flow.motive.placeholder")}
            className="h-11 w-full rounded-md border border-hairline bg-surface-1 px-3 text-body-1 text-text-primary placeholder:text-text-tertiary focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          />
        </div>

        {/* CTA — disabled until a valid amount is entered. */}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={!ctaEnabled}
          title={!ctaEnabled ? t("advance.flow.cta_blocked.amount") : undefined}
          aria-describedby={!ctaEnabled ? "advance-cta-help" : undefined}
        >
          {t("advance.flow.cta_grant")}
        </Button>
        {!ctaEnabled ? (
          <span id="advance-cta-help" className="sr-only">
            {t("advance.flow.cta_blocked.amount")}
          </span>
        ) : null}
      </form>
    </section>
  );
}
