// Story 4.1 — MemberActionSheet (Flow 1 entry surface).
//
// Bottom-anchored modal shell that hosts the daily-contribution interaction
// (the product's defining gesture: 1 tap → toast → done). Implemented on
// the native <dialog> element (zero dep, same pattern as Stories 2.6 + 2.7).
//
// Story 4.1 ships the SHELL only — the 4 transaction CTAs render with
// optional `on*` handler props. When omitted (Story 4.1's default in
// MemberList), the CTA renders disabled. Stories 4.3 / 4.4 / 4.5 wire the
// real handlers (`useRecordContribution`, `useRattrapage`, `useAdvance`,
// `useCustomAmount`).
//
// Closed-cycle gate consumes Story 3.4's pre-shipped helper
// `isCycleClosedForTransactions(cycle)` + i18n key
// `members.profile.cycle_closed_blocked`.
//
// See: epics.md:788-806 (Story 4.1 BDD), prd.md:505 (FR22),
// ux-design-specification.md:433-470 (Flow 1 spec),
// architecture.md:878 (component slot).

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { RATTRAPAGE_DAY_OPTIONS, isCycleClosedForTransactions } from "@/domain/cycle";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { memberInitials } from "@/features/member/api/memberInitials";
import { useT } from "@/i18n/useT";

type CycleStatusValue = "active" | "with_advance" | "completed" | "settled";

/** Story 4.4 — long-press timing. 500ms is the ergonomic reveal threshold
 *  per UX spec line 453 (UX-DR6). Below this, the press is interpreted as
 *  a click on the primary CTA (commit a contribution). */
const RATTRAPAGE_LONGPRESS_MS = 500;

export interface MemberActionSheetMember {
  id: string;
  name: string;
  dailyAmount: number;
}

export interface MemberActionSheetProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  member: MemberActionSheetMember;
  currentCycle: { status: CycleStatusValue } | null;
  /** Story 4.4 — caller passes daysRemaining when a current cycle exists,
   *  so the inline rattrapage grid can grey out N > daysRemaining options.
   *  When the cycle is null/closed the value is ignored. */
  daysRemaining?: number;
  onRecordContribution?: (memberId: string) => void;
  /** Story 4.4 — signature changes from Story 4.1's `(id) => void` to
   *  `(id, daysCovered) => void`. The grid passes the selected N. */
  onRattrapage?: (memberId: string, daysCovered: number) => void;
  onAdvance?: (memberId: string) => void;
  onCustomAmount?: (memberId: string) => void;
  onViewProfile: (memberId: string) => void;
}

export function MemberActionSheet({
  open,
  onOpenChange,
  member,
  currentCycle,
  daysRemaining = 0,
  onRecordContribution,
  onRattrapage,
  onAdvance,
  onCustomAmount,
  onViewProfile,
}: MemberActionSheetProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closed = isCycleClosedForTransactions(currentCycle);

  // Story 4.4 — inline rattrapage grid state. Opens via long-press on the
  // primary CTA OR tap on the secondary "Rattrapage" link. Resets when
  // the sheet closes.
  const [rattrapageMenuOpen, setRattrapageMenuOpen] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressedLongRef = useRef(false);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  // The internal close path resets the inline grid + long-press state.
  // The external close path (parent flips `open` to false / unmounts the
  // sheet) is handled by React's natural unmount of the dialog tree —
  // MemberList sets `activeMemberId = null`, which removes this sheet
  // entirely, so local state resets automatically on the next open.
  const close = () => {
    setRattrapageMenuOpen(false);
    pressedLongRef.current = false;
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    onOpenChange(false);
  };

  // Backdrop click — the click target is the <dialog> itself when the
  // user taps the overlay area outside the inner content. Tapping the
  // inner content stops propagation so we don't dismiss on every click.
  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  // Helpers that fall back to disabled when the parent doesn't pass a
  // handler (Story 4.1's default for the 4 transaction CTAs — Stories
  // 4.3-4.5 plug them in).
  const callIfReady = (handler: ((memberId: string) => void) | undefined) => () => {
    if (!handler) return;
    handler(member.id);
    close();
  };

  // Story 4.4 — long-press logic on the primary CTA. pointerdown arms the
  // timer; pointerup/cancel/leave clears it. If the timer fires (≥ 500ms
  // held) we open the rattrapage grid AND set pressedLongRef so the
  // synthetic click that would otherwise commit a contribution is
  // suppressed in handlePrimaryClick.
  const armLongPress = () => {
    if (closed || !onRattrapage) return;
    pressedLongRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      pressedLongRef.current = true;
      setRattrapageMenuOpen(true);
      longPressTimerRef.current = null;
    }, RATTRAPAGE_LONGPRESS_MS);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handlePrimaryClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (pressedLongRef.current) {
      e.preventDefault();
      pressedLongRef.current = false;
      return;
    }
    callIfReady(onRecordContribution)();
  };

  const handleRattrapagePick = (n: number) => {
    if (!onRattrapage) return;
    onRattrapage(member.id, n);
    close();
  };

  const handleSecondaryRattrapageTap = () => {
    if (closed || !onRattrapage) return;
    setRattrapageMenuOpen((prev) => !prev);
  };

  return (
    // jsx-a11y flags click on `<dialog>` because it can't infer that the
    // native element is interactive. The backdrop-click pattern is the
    // standard HTML5 dismissal idiom for modal dialogs (BDD AC #8).
    /* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */
    <dialog
      ref={dialogRef}
      onClose={close}
      onClick={handleBackdropClick}
      aria-labelledby="member-action-sheet-title"
      aria-label={t("members.action_sheet.aria_label", { name: member.name })}
      className="m-auto mb-0 w-full max-w-md rounded-t-2xl rounded-b-none border-x border-t border-hairline bg-card p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      {/* Inner content stops propagation so taps inside the sheet don't
          trigger the backdrop dismissal above. */}
      <div className="flex flex-col gap-4 p-6" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3">
          <div
            aria-hidden
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-100 text-title-2 font-semibold text-primary-700"
          >
            {memberInitials(member.name)}
          </div>
          <h2 id="member-action-sheet-title" className="truncate text-headline-2 text-text-primary">
            {member.name}
          </h2>
        </header>

        {closed ? (
          <p
            role="status"
            className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-body-2 text-warning-800"
          >
            {t("members.profile.cycle_closed_blocked")}
          </p>
        ) : null}

        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={handlePrimaryClick}
          onPointerDown={armLongPress}
          onPointerUp={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerCancel={cancelLongPress}
          disabled={!onRecordContribution || closed}
        >
          {t("members.action_sheet.primary_cta", {
            amount: formatFcfaAmount(member.dailyAmount),
          })}
        </Button>

        {rattrapageMenuOpen && onRattrapage && !closed ? (
          <div
            role="group"
            aria-label={t("members.action_sheet.rattrapage_aria")}
            className="grid grid-cols-3 gap-2"
          >
            {RATTRAPAGE_DAY_OPTIONS.map((n) => {
              const disabled = n > daysRemaining;
              return (
                <Button
                  key={n}
                  type="button"
                  variant="outline"
                  size="default"
                  onClick={() => handleRattrapagePick(n)}
                  disabled={disabled}
                  aria-disabled={disabled}
                  data-rattrapage-option={n}
                >
                  {t("members.action_sheet.rattrapage_option", { n })}
                </Button>
              );
            })}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={handleSecondaryRattrapageTap}
            disabled={!onRattrapage || closed}
            aria-expanded={rattrapageMenuOpen}
          >
            {t("members.action_sheet.secondary_rattrapage")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={callIfReady(onAdvance)}
            disabled={!onAdvance || closed}
          >
            {t("members.action_sheet.secondary_advance")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={callIfReady(onCustomAmount)}
            disabled={!onCustomAmount || closed}
          >
            {t("members.action_sheet.secondary_custom")}
          </Button>
          <Button type="button" variant="ghost" size="default" onClick={callIfReady(onViewProfile)}>
            {t("members.action_sheet.secondary_view_profile")}
          </Button>
        </div>
      </div>
    </dialog>
    /* eslint-enable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions */
  );
}
