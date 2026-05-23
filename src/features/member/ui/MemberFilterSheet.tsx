// 2026-05-23 — Bottom-sheet host for the status-filter chips.
//
// Replaces the inline wrap-chip group on MemberList: the chips ate two
// rows of vertical space on a 360 px viewport (worse with the 5th
// "Déjà payés" chip). The sheet collapses them behind a single compact
// "Filtres" trigger and surfaces them via native checkboxes that match
// the OS-level multi-select pattern.
//
// State model: this component is pure presentation. `selectedChips` /
// `onToggle` / `onClear` come from MemberList — the sheet just renders
// the current state and forwards changes. No internal temp state: a tap
// applies immediately so the live `resultCount` reflects reality, and the
// closing CTA reads "Voir N membre(s)" so the user has feedback without
// an explicit "Apply" step (matches Instagram/Maps multi-select pattern).
//
// Built on the same native <dialog> primitive as
// ResendHistoryDialog / TransactionReceiptSheet (zero new deps) but
// styled as a bottom-anchored sheet (mt-auto + mb-0 + rounded-t-2xl) for
// the mobile-native feel — on desktop it degrades to a bottom-of-screen
// modal that's still perfectly usable.

import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

export interface MemberFilterOption<TValue extends string> {
  value: TValue;
  labelKey: TranslationKey;
}

export interface MemberFilterSheetProps<TValue extends string> {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  options: readonly MemberFilterOption<TValue>[];
  selected: ReadonlySet<TValue>;
  onToggle: (value: TValue) => void;
  onClear: () => void;
  /** Live count of members matching the current filter selection.
   *  Drives the closing-CTA copy ("Voir N membres") so the user has
   *  immediate feedback that their changes have an effect. */
  resultCount: number;
}

export function MemberFilterSheet<TValue extends string>({
  open,
  onOpenChange,
  options,
  selected,
  onToggle,
  onClear,
  resultCount,
}: MemberFilterSheetProps<TValue>) {
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

  const resultLabel: TranslationKey =
    resultCount === 0
      ? "members.filter_sheet.apply_zero"
      : resultCount === 1
        ? "members.filter_sheet.apply_one"
        : "members.filter_sheet.apply_many";

  return (
    /* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */
    <dialog
      ref={dialogRef}
      onClose={close}
      onClick={handleBackdropClick}
      aria-labelledby="member-filter-sheet-title"
      className="mx-auto mb-0 mt-auto w-full max-w-md rounded-t-2xl rounded-b-none border border-hairline border-b-0 bg-card p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      <div className="flex flex-col gap-4 p-6" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3">
          <h2 id="member-filter-sheet-title" className="text-headline-2 text-text-primary">
            {t("members.filter_sheet.title")}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={t("members.filter_sheet.close_label")}
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          >
            <X size={20} aria-hidden />
          </button>
        </header>

        <ul className="flex flex-col" aria-label={t("members.filter_sheet.options_aria")}>
          {options.map((option) => {
            const checked = selected.has(option.value);
            const inputId = `member-filter-${option.value}`;
            return (
              <li key={option.value}>
                <label
                  htmlFor={inputId}
                  className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-body-1 text-text-primary hover:bg-primary-50"
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(option.value)}
                    data-filter-option={option.value}
                    className="h-5 w-5 accent-primary-500"
                  />
                  <span className="flex-1">{t(option.labelKey)}</span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={onClear}
            disabled={selected.size === 0}
          >
            {t("members.filter_sheet.clear")}
          </Button>
          <Button type="button" size="lg" className="flex-1" onClick={close}>
            {t(resultLabel, { n: resultCount })}
          </Button>
        </div>
      </div>
    </dialog>
    /* eslint-enable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */
  );
}

/** Compact trigger that opens the sheet. Lives next to the search box on
 *  MemberList. Shows the active-filter count when > 0 so collectors know
 *  a filter is in effect at a glance. */
export interface MemberFilterTriggerProps {
  onClick: () => void;
  activeCount: number;
}

export function MemberFilterTrigger({ onClick, activeCount }: MemberFilterTriggerProps) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      data-active-filter-count={activeCount}
      className="inline-flex min-h-[44px] items-center gap-2 self-start rounded-full border border-hairline bg-card px-4 text-body-2 font-medium text-text-primary hover:bg-primary-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
    >
      <SlidersHorizontal size={16} aria-hidden />
      <span>{t("members.filter_sheet.trigger_label")}</span>
      {activeCount > 0 ? (
        <span
          aria-label={t("members.filter_sheet.trigger_count_aria", { n: activeCount })}
          className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-500 px-1 text-caption font-semibold text-primary-foreground"
        >
          {activeCount}
        </span>
      ) : null}
    </button>
  );
}
