// Story 12.1 — period filter for the Journal page.
//
// 2026-05-23 — refactored from an inline 3-pill radio row to a compact
// "Filtres" trigger that opens a bottom-anchored sheet hosting the
// radio options. Same visual language as MemberList's filter sheet
// (member/ui/MemberFilterSheet) so the two surfaces feel coherent. The
// period is single-select (mutually exclusive), so tapping a radio
// applies immediately and closes the sheet — no separate "Appliquer"
// CTA needed.

import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { TranslationKey } from "@/i18n/keys";
import { useT } from "@/i18n/useT";

import { JOURNAL_PERIODS, type JournalPeriod } from "../api/period";

const LABEL_KEY: Record<JournalPeriod, TranslationKey> = {
  cycle_previous: "journal.period.previous_cycle",
  cycle_current: "journal.period.current_cycle",
  last_seven_days: "journal.period.last_seven_days",
};

export interface JournalPeriodSelectorProps {
  value: JournalPeriod;
  onChange: (next: JournalPeriod) => void;
}

export function JournalPeriodSelector({
  value,
  onChange,
}: JournalPeriodSelectorProps): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
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

  const close = () => setOpen(false);

  const handlePick = (period: JournalPeriod) => {
    onChange(period);
    close();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-active-period={value}
        className="inline-flex min-h-[44px] items-center gap-2 self-start rounded-full border border-hairline bg-card px-4 text-body-2 font-medium text-text-primary hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
      >
        <SlidersHorizontal size={16} aria-hidden />
        <span>{t("journal.period_trigger_label")}</span>
        <span aria-hidden className="text-text-secondary">
          ·
        </span>
        <span className="text-primary-700">{t(LABEL_KEY[value])}</span>
      </button>

      {/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */}
      <dialog
        ref={dialogRef}
        onClose={close}
        onClick={handleBackdropClick}
        aria-labelledby="journal-period-sheet-title"
        className="mx-auto mb-0 mt-auto w-full max-w-md rounded-t-2xl rounded-b-none border border-hairline border-b-0 bg-card p-0 shadow-xl backdrop:bg-neutral-900/50"
      >
        <div className="flex flex-col gap-4 p-6" onClick={(e) => e.stopPropagation()}>
          <header className="flex items-center justify-between gap-3">
            <h2 id="journal-period-sheet-title" className="text-headline-2 text-text-primary">
              {t("journal.period_sheet_title")}
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label={t("journal.period_sheet_close_label")}
              className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            >
              <X size={20} aria-hidden />
            </button>
          </header>

          <div
            role="radiogroup"
            aria-label={t("journal.period_aria_label")}
            className="flex flex-col"
          >
            {JOURNAL_PERIODS.map((period) => {
              const active = period === value;
              const inputId = `journal-period-${period}`;
              return (
                <label
                  key={period}
                  htmlFor={inputId}
                  className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-body-1 text-text-primary hover:bg-primary-50"
                >
                  <input
                    id={inputId}
                    type="radio"
                    name="journal-period"
                    value={period}
                    checked={active}
                    onChange={() => handlePick(period)}
                    className="h-5 w-5 accent-primary-500"
                  />
                  <span className="flex-1">{t(LABEL_KEY[period])}</span>
                </label>
              );
            })}
          </div>
        </div>
      </dialog>
      {/* eslint-enable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */}
    </>
  );
}
