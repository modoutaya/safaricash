// Story 6.7 — TransactionReceiptSheet.
//
// Centered modal showing one transaction's receipt detail with two
// actions: share (OS share sheet via Web Share API, with clipboard fallback)
// and resend SMS. Same native <dialog> pattern as MemberActionSheet (Story
// 4.1) — no shadcn Sheet dep.
//
// Pure presentation: the parent route wires onShare + onResend to the
// shareReceipt helper / useResendTransaction hook.

import { MessageSquare, Share2, X } from "lucide-react";
import { createElement, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import type { TransactionKind, TransactionRow } from "@/features/member";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { formatTransactionTime } from "@/features/member/api/formatTransactionTime";
import { transactionIcon } from "@/features/member/api/transactionIcon";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

export interface TransactionReceiptSheetMember {
  /** Plaintext phone (null if cash-only saver — disables the SMS button). */
  phone_number: string | null;
  /** Story 6.5 — disables SMS button when the saver has opted out. */
  sms_opt_out: boolean;
}

export interface TransactionReceiptSheetCycle {
  cycle_number: number;
}

export interface TransactionReceiptSheetProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  transaction: TransactionRow;
  member: TransactionReceiptSheetMember;
  cycle: TransactionReceiptSheetCycle;
  onShare: () => void;
  onResend: () => void;
}

const KIND_LABEL_KEY: Record<TransactionKind, TranslationKey> = {
  contribution: "members.profile.transactions.kind_contribution",
  rattrapage: "members.profile.transactions.kind_rattrapage",
  advance: "members.profile.transactions.kind_advance",
};

export function TransactionReceiptSheet({
  open,
  onOpenChange,
  transaction,
  member,
  cycle,
  onShare,
  onResend,
}: TransactionReceiptSheetProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  const close = () => onOpenChange(false);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  const isAdvance = transaction.kind === "advance";
  const amountPrefix = isAdvance ? "−" : "";

  const resendDisabledReason: TranslationKey | null = !member.phone_number
    ? "transaction.receipt_sheet.resend_disabled_no_phone"
    : member.sms_opt_out
      ? "transaction.receipt_sheet.resend_disabled_opt_out"
      : null;
  const resendDisabled = resendDisabledReason !== null;

  return (
    /* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */
    <dialog
      ref={dialogRef}
      onClose={close}
      onClick={handleBackdropClick}
      aria-labelledby="transaction-receipt-sheet-title"
      className="m-auto w-full max-w-md rounded-2xl border border-hairline bg-card p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      <div className="flex flex-col gap-4 p-6" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3">
          <h2 id="transaction-receipt-sheet-title" className="text-headline-2 text-text-primary">
            {t("transaction.receipt_sheet.title")}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={t("transaction.receipt_sheet.close_label")}
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          >
            <X size={20} aria-hidden />
          </button>
        </header>

        <dl
          className="flex flex-col gap-3 text-body-2"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          <div className="flex items-center justify-between gap-3">
            <dt className="sr-only">{t("transaction.receipt_sheet.kind_row_label")}</dt>
            <dd className="flex items-center gap-2 text-text-primary">
              <span
                aria-hidden
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  isAdvance ? "bg-warning-bg text-warning" : "bg-primary-50 text-primary-700"
                }`}
              >
                {createElement(transactionIcon(transaction.kind), { size: 16 })}
              </span>
              <span className="font-medium">{t(KIND_LABEL_KEY[transaction.kind])}</span>
            </dd>
          </div>

          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-secondary">
              {t("transaction.receipt_sheet.amount_row_label")}
            </dt>
            <dd className={`font-semibold ${isAdvance ? "text-warning" : "text-text-primary"}`}>
              {amountPrefix}
              {formatFcfaAmount(transaction.amount)} FCFA
            </dd>
          </div>

          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-secondary">{t("transaction.receipt_sheet.date_row_label")}</dt>
            <dd className="text-text-primary">{formatTransactionTime(transaction.created_at)}</dd>
          </div>

          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-secondary">
              {t("transaction.receipt_sheet.cycle_day_row_label")}
            </dt>
            <dd className="text-text-primary">
              {t("transaction.receipt_sheet.cycle_day_value", {
                n: transaction.cycle_day,
                cycle_number: cycle.cycle_number,
              })}
            </dd>
          </div>
        </dl>

        <div className="flex flex-col gap-2 pt-2">
          <Button type="button" size="lg" className="w-full" onClick={() => onShare()}>
            <Share2 size={18} aria-hidden className="mr-2" />
            {t("transaction.receipt_sheet.share_label")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            onClick={() => onResend()}
            disabled={resendDisabled}
            title={resendDisabled ? t(resendDisabledReason) : undefined}
          >
            <MessageSquare size={18} aria-hidden className="mr-2" />
            {t("transaction.receipt_sheet.resend_sms_label")}
          </Button>
          {resendDisabled ? (
            <p className="text-caption text-text-secondary">{t(resendDisabledReason)}</p>
          ) : null}
        </div>
      </div>
    </dialog>
    /* eslint-enable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */
  );
}
