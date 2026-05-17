// Story 4.6 — NewTransactionForm.
//
// Full-page transaction surface replacing the Story 4.1 MemberActionSheet
// modal. Faithful to 03-mockups.html "Nouvelle Transaction": a white
// "Détails de l'opération" card holding a member <select>, a type
// <select> (Cotisation / Rattrapage / Prêt), the suggested-amount display
// box, an optional custom-amount input and the submit button.
//
// Pure presentation — the route owns data, mutations, toasts, navigation.
// The member <select> is functional: changing it re-navigates to that
// member's transaction page (onSelectMember). The green topbar uses
// primary-700 so the white text clears WCAG AA (the axe E2E gates this
// page; the mockup's lighter primary-500 gradient would fail).

import { ArrowLeft, ChevronDown } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RATTRAPAGE_DAY_OPTIONS } from "@/domain/cycle";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import type { TranslationKey } from "@/i18n/keys";
import { useT } from "@/i18n/useT";

export type TransactionType = "contribution" | "rattrapage" | "advance";

export interface MemberOption {
  id: string;
  name: string;
  /** FCFA integer — the member's daily contribution. */
  dailyAmount: number;
}

export interface NewTransactionFormProps {
  /** Members eligible for a transaction — populates the member <select>. */
  members: ReadonlyArray<MemberOption>;
  /** The member this page is currently scoped to. */
  selectedMemberId: string;
  /** FCFA integer — the selected member's daily contribution. */
  dailyAmount: number;
  /** Days left in the cycle — rattrapage options past this are disabled. */
  daysRemaining: number;
  isPending: boolean;
  onBack: () => void;
  onSelectMember: (memberId: string) => void;
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

const SELECT_CLASS =
  "h-11 w-full appearance-none rounded-md border border-hairline bg-surface-1 pl-3 pr-9 " +
  "text-body-1 text-text-primary focus-visible:outline-none focus-visible:border-primary " +
  "focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

function AmountDisplay({
  amount,
  currency,
  label,
}: {
  amount: string;
  currency: string;
  label: string;
}): JSX.Element {
  // The 💰 mark is a ::before pseudo-element — like the mockup, and so the
  // axe color-contrast rule (which only inspects real text nodes) skips the
  // decorative low-opacity glyph.
  return (
    <div className="relative rounded-lg border-2 border-primary-500 bg-gradient-to-br from-primary-100 to-primary-50 p-5 text-center before:absolute before:right-4 before:top-4 before:text-title-1 before:opacity-30 before:content-['💰']">
      <p
        className="text-amount-large text-primary-700"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {amount}
      </p>
      <p className="text-title-2 text-primary-700">{currency}</p>
      <p className="mt-1 text-caption text-primary-700">{label}</p>
    </div>
  );
}

export function NewTransactionForm({
  members,
  selectedMemberId,
  dailyAmount,
  daysRemaining,
  isPending,
  onBack,
  onSelectMember,
  onViewProfile,
  onSubmitContribution,
  onSubmitRattrapage,
  onGoToAdvance,
}: NewTransactionFormProps): JSX.Element {
  const t = useT();
  const [type, setType] = useState<TransactionType>("contribution");
  const [customAmount, setCustomAmount] = useState("");
  const [selectedDays, setSelectedDays] = useState<number | null>(null);

  // The custom amount is optional — left blank, the suggested daily amount
  // is used. When filled it must be a valid FCFA integer in range.
  const customRaw = customAmount.trim();
  const customNum = Number(customRaw);
  const customValid =
    customRaw === "" ||
    (Number.isInteger(customNum) && customNum >= MIN_AMOUNT && customNum <= MAX_AMOUNT);
  const effectiveAmount = customRaw === "" ? dailyAmount : customNum;

  const submitDisabled =
    isPending ||
    (type === "contribution" && !customValid) ||
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
      onSubmitContribution(effectiveAmount);
    }
  };

  return (
    <section
      className="mx-auto flex w-full max-w-2xl flex-col"
      aria-label={t("transaction.new.aria_label")}
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
        <h1 className="text-title-1">{t("transaction.new.topbar_title")}</h1>
        <p className="text-body-2 text-primary-foreground/90">{t("transaction.new.subtitle")}</p>
      </header>

      <div className="p-4">
        <div className="flex flex-col gap-4 rounded-lg border border-hairline bg-card p-5">
          <h2 className="text-title-2 text-primary-700">{t("transaction.new.form_title")}</h2>

          {/* Member selector — switching re-navigates to that member. */}
          <div className="flex flex-col gap-2">
            <label
              htmlFor="transaction-member"
              className="text-caption font-semibold text-primary-700"
            >
              {t("transaction.new.member_label")}
            </label>
            <div className="relative">
              <select
                id="transaction-member"
                value={selectedMemberId}
                disabled={isPending}
                onChange={(e) => onSelectMember(e.target.value)}
                className={SELECT_CLASS}
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {t("transaction.new.member_option", {
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
            <button
              type="button"
              onClick={onViewProfile}
              className="w-fit text-body-2 font-medium text-primary-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t("transaction.new.view_profile")}
            </button>
          </div>

          {/* Operation type. */}
          <div className="flex flex-col gap-2">
            <label
              htmlFor="transaction-type"
              className="text-caption font-semibold text-primary-700"
            >
              {t("transaction.new.type_label")}
            </label>
            <div className="relative">
              <select
                id="transaction-type"
                value={type}
                disabled={isPending}
                onChange={(e) => setType(e.target.value as TransactionType)}
                className={SELECT_CLASS}
              >
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary-500"
              />
            </div>
          </div>

          {/* Cotisation — suggested amount + optional custom override. */}
          {type === "contribution" ? (
            <>
              <AmountDisplay
                amount={formatFcfaAmount(dailyAmount)}
                currency={t("transaction.new.amount.currency")}
                label={t("transaction.new.amount.suggested_label")}
              />
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="transaction-amount"
                  className="text-caption font-semibold text-primary-700"
                >
                  {t("transaction.new.contribution.custom_label")}
                </label>
                <Input
                  id="transaction-amount"
                  type="number"
                  inputMode="numeric"
                  min={MIN_AMOUNT}
                  max={MAX_AMOUNT}
                  step={1}
                  placeholder={t("transaction.new.contribution.custom_placeholder")}
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  disabled={isPending}
                />
              </div>
            </>
          ) : null}

          {/* Rattrapage — day picker, then the running total. */}
          {type === "rattrapage" ? (
            <>
              <div className="flex flex-col gap-2">
                <p className="text-caption font-semibold text-primary-700">
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
              </div>
              {selectedDays !== null ? (
                <AmountDisplay
                  amount={formatFcfaAmount(selectedDays * dailyAmount)}
                  currency={t("transaction.new.amount.currency")}
                  label={t("transaction.new.rattrapage.total_label")}
                />
              ) : null}
            </>
          ) : null}

          {/* Prêt — links out to the dedicated advance flow. */}
          {type === "advance" ? (
            <p className="text-body-2 text-text-secondary">{t("transaction.new.advance.note")}</p>
          ) : null}

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
      </div>
    </section>
  );
}
