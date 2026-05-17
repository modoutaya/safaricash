// Story 4.6 — NewTransactionForm.
//
// Full-page transaction surface replacing the Story 4.1 MemberActionSheet
// modal. A type selector (Cotisation / Rattrapage / Prêt): Cotisation has
// an editable amount (the long-dormant "montant personnalisé"), Rattrapage
// a day picker, Prêt links out to the existing /members/:id/advance flow.
//
// Pure presentation — the route owns data, mutations, toasts, navigation.
// The green topbar uses primary-700 so the white text clears WCAG AA (the
// axe E2E gates this page; primary-500 would fail).
//
// Visual reference: 03-mockups.html "Nouvelle Transaction".

import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RATTRAPAGE_DAY_OPTIONS } from "@/domain/cycle";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import type { TranslationKey } from "@/i18n/keys";
import { useT } from "@/i18n/useT";

export type TransactionType = "contribution" | "rattrapage" | "advance";

export interface NewTransactionFormProps {
  memberName: string;
  /** FCFA integer — the member's daily contribution; pre-fills the amount. */
  dailyAmount: number;
  /** Days left in the cycle — rattrapage options past this are disabled. */
  daysRemaining: number;
  isPending: boolean;
  onBack: () => void;
  onViewProfile: () => void;
  onSubmitContribution: (amount: number) => void;
  onSubmitRattrapage: (daysCovered: number) => void;
  onGoToAdvance: () => void;
}

const MIN_AMOUNT = 100;
const MAX_AMOUNT = 100000;

const TYPE_OPTIONS: ReadonlyArray<{ value: TransactionType; labelKey: TranslationKey }> = [
  { value: "contribution", labelKey: "transaction.new.type_contribution" },
  { value: "rattrapage", labelKey: "transaction.new.type_rattrapage" },
  { value: "advance", labelKey: "transaction.new.type_advance" },
];

export function NewTransactionForm({
  memberName,
  dailyAmount,
  daysRemaining,
  isPending,
  onBack,
  onViewProfile,
  onSubmitContribution,
  onSubmitRattrapage,
  onGoToAdvance,
}: NewTransactionFormProps): JSX.Element {
  const t = useT();
  const [type, setType] = useState<TransactionType>("contribution");
  const [amount, setAmount] = useState(String(dailyAmount));
  const [selectedDays, setSelectedDays] = useState<number | null>(null);

  const amountNum = Number(amount);
  const amountValid =
    Number.isInteger(amountNum) && amountNum >= MIN_AMOUNT && amountNum <= MAX_AMOUNT;

  const submitDisabled =
    isPending ||
    (type === "contribution" && !amountValid) ||
    (type === "rattrapage" && selectedDays === null);

  const submitLabel =
    type === "advance"
      ? t("transaction.new.advance.cta")
      : type === "rattrapage"
        ? t("transaction.new.rattrapage.cta")
        : t("transaction.new.contribution.cta");

  const handleSubmit = (): void => {
    if (submitDisabled) return;
    if (type === "advance") {
      onGoToAdvance();
    } else if (type === "rattrapage") {
      if (selectedDays !== null) onSubmitRattrapage(selectedDays);
    } else {
      onSubmitContribution(amountNum);
    }
  };

  return (
    <section
      className="mx-auto flex w-full max-w-2xl flex-col"
      aria-label={t("transaction.new.title")}
    >
      {/* Full-bleed green topbar — primary-700 keeps the white text AA-safe. */}
      <header className="flex flex-col gap-1 bg-primary-700 px-4 pb-6 pt-4 text-primary-foreground">
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          className="-ml-1 inline-flex w-fit items-center gap-1 rounded-md py-1 pl-1 pr-2 text-body-2 text-primary-foreground/90 hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground disabled:opacity-50"
        >
          <ArrowLeft aria-hidden className="h-4 w-4 shrink-0" />
          {t("transaction.new.back_label")}
        </button>
        <h1 className="text-title-1">{t("transaction.new.title")}</h1>
        <p className="text-body-2 text-primary-foreground/90">{t("transaction.new.subtitle")}</p>
      </header>

      <div className="flex flex-col gap-4 p-4">
        {/* Member + profile link. */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-card p-4">
          <span className="min-w-0 truncate text-body-1 font-semibold text-text-primary">
            {memberName}
          </span>
          <button
            type="button"
            onClick={onViewProfile}
            className="shrink-0 text-body-2 font-medium text-primary-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("transaction.new.view_profile")}
          </button>
        </div>

        {/* Type selector. */}
        <div
          role="group"
          aria-label={t("transaction.new.type_label")}
          className="grid grid-cols-3 gap-2"
        >
          {TYPE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={type === option.value ? "default" : "outline"}
              aria-pressed={type === option.value}
              onClick={() => setType(option.value)}
            >
              {t(option.labelKey)}
            </Button>
          ))}
        </div>

        {/* Per-type fields. */}
        <section className="flex flex-col gap-3 rounded-lg border border-hairline bg-card p-4">
          {type === "contribution" ? (
            <div className="flex flex-col gap-2">
              <label
                htmlFor="transaction-amount"
                className="text-caption font-medium text-text-primary"
              >
                {t("transaction.new.contribution.amount_label")}
              </label>
              <Input
                id="transaction-amount"
                type="number"
                inputMode="numeric"
                min={MIN_AMOUNT}
                max={MAX_AMOUNT}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={isPending}
              />
              <p className="text-body-2 text-text-secondary">
                {t("transaction.new.contribution.amount_helper", {
                  amount: formatFcfaAmount(dailyAmount),
                })}
              </p>
            </div>
          ) : type === "rattrapage" ? (
            <div className="flex flex-col gap-2">
              <p className="text-caption font-medium text-text-primary">
                {t("transaction.new.rattrapage.days_label")}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {RATTRAPAGE_DAY_OPTIONS.map((n) => {
                  const disabled = n > daysRemaining || isPending;
                  return (
                    <Button
                      key={n}
                      type="button"
                      variant={selectedDays === n ? "default" : "outline"}
                      aria-pressed={selectedDays === n}
                      disabled={disabled}
                      onClick={() => setSelectedDays(n)}
                    >
                      {t("transaction.new.rattrapage.day_option", { n })}
                    </Button>
                  );
                })}
              </div>
              {selectedDays !== null ? (
                <p
                  className="text-body-2 text-text-secondary"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {t("transaction.new.rattrapage.summary", {
                    n: selectedDays,
                    daily: formatFcfaAmount(dailyAmount),
                    total: formatFcfaAmount(selectedDays * dailyAmount),
                  })}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-body-2 text-text-secondary">{t("transaction.new.advance.note")}</p>
          )}
        </section>

        <Button
          type="button"
          size="lg"
          className="w-full"
          disabled={submitDisabled}
          onClick={handleSubmit}
        >
          {submitLabel}
        </Button>
      </div>
    </section>
  );
}
