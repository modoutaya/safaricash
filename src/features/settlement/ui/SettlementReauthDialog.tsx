// Story 7.4 — SettlementReauthDialog.
//
// Password-gated confirmation modal for FR21 cycle settlement. Built on the
// native <dialog> element (same pattern as Stories 6.6 / 2.6 — zero new deps).
//
// State machine:
//   "typing-password" — single step; user enters password and submits.
//
// On success (commit returns {settlement_transaction_id, settled_payout, settled_at}):
//   - Calls onSuccess(result); dialog closes; parent toasts + view-swap.
//
// On credentials_invalid    → clear password, inline alert, stay open.
// On rate_limited           → inline alert, stay open.
// On payout_mismatch        → calls onError; dialog closes (caller reloads).
// On cycle_not_settleable   → calls onError; dialog closes (caller reloads).
// On anything else          → calls onError; dialog closes; parent toasts.

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { memberInitials } from "@/features/member/api/memberInitials";
import { useT } from "@/i18n/useT";

import { useCommitSettlement, type CommitSettlementResult } from "../api/useCommitSettlement";
import type { CommitSettlementError } from "../api/commitSettlementError";

export interface SettlementReauthDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  memberId: string;
  cycleId: string;
  memberName: string;
  /** Client-computed payout (Story 7.1's settle()). Server cross-checks. */
  expectedPayout: number;
  /** Called when commit_cycle_settlement returns 200. */
  onSuccess: (result: CommitSettlementResult) => void;
  /** Called for non-credential errors (network / payout_mismatch / not_found / 500). */
  onError: (err: CommitSettlementError) => void;
  /**
   * Story 7.4 code-review patch #1 — sync the dialog's mutation in-flight
   * state up to the parent route, so the route can drive `isSubmitting`
   * on `<SettlementSummaryCard>` (Story 7.1 AC #4). Without this signal
   * the route would have to instantiate its own useCommitSettlement which
   * would be a SECOND, independent mutation that never fires — leaving
   * the card's CTAs clickable during commit.
   */
  onMutatingChange?: (mutating: boolean) => void;
}

type InlineError = "invalid" | "rate_limited" | null;

interface SettlementReauthDialogBodyProps extends Omit<
  SettlementReauthDialogProps,
  "open" | "onOpenChange"
> {
  closeDialog: () => void;
  setMutating: (next: boolean) => void;
}

export function SettlementReauthDialog(props: SettlementReauthDialogProps) {
  const { open, onOpenChange, onMutatingChange } = props;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [bodyMutating, setBodyMutating] = useState(false);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  // Story 7.4 code-review patch #1 — propagate dialog body's mutation
  // in-flight state up to the route so it can disable the SummaryCard
  // CTAs (Story 7.1 AC #4 isSubmitting). The dialog is the only place
  // that holds a useCommitSettlement instance; without this bridge the
  // route's CTAs stay enabled during commit.
  useEffect(() => {
    onMutatingChange?.(bodyMutating);
  }, [bodyMutating, onMutatingChange]);

  const closeDialog = () => onOpenChange(false);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      onCancel={(e) => {
        if (bodyMutating) e.preventDefault();
      }}
      aria-labelledby="settlement-reauth-dialog-title"
      aria-describedby="settlement-reauth-dialog-body"
      className="m-auto w-[90%] max-w-sm rounded-lg border border-neutral-200 bg-background p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      {open ? (
        <SettlementReauthDialogBody
          {...props}
          closeDialog={closeDialog}
          setMutating={setBodyMutating}
        />
      ) : null}
    </dialog>
  );
}

function SettlementReauthDialogBody({
  memberId,
  cycleId,
  memberName,
  expectedPayout,
  onSuccess,
  onError,
  closeDialog,
  setMutating,
}: SettlementReauthDialogBodyProps) {
  const t = useT();
  const commit = useCommitSettlement();

  const [password, setPassword] = useState("");
  const [inlineError, setInlineError] = useState<InlineError>(null);

  const isMutating = commit.isPending;
  const firstName = memberName.split(" ")[0] ?? memberName;

  useEffect(() => {
    setMutating(isMutating);
  }, [isMutating, setMutating]);

  const handleSubmit = async () => {
    // Story 6.6 P8 — trim before length check.
    const trimmed = password.trim();
    if (trimmed.length === 0 || isMutating) return;
    setInlineError(null);
    try {
      const result = await commit.mutateAsync({
        memberId,
        cycleId,
        expectedPayout,
        password: trimmed,
      });
      onSuccess(result);
      closeDialog();
    } catch (err) {
      const code = (err as CommitSettlementError).code;
      if (code === "credentials_invalid") {
        setInlineError("invalid");
        setPassword("");
        return;
      }
      if (code === "rate_limited") {
        setInlineError("rate_limited");
        setPassword("");
        return;
      }
      // payout_mismatch / cycle_not_settleable / not_found / network / 500
      // / unknown — surface upstream so the route can decide (toast +
      // navigate-back vs. just-toast).
      onError(err as CommitSettlementError);
      closeDialog();
    }
  };

  // Story 6.6 P3 — form-wrap so Enter submits.
  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void handleSubmit();
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-100 text-title-2 font-semibold text-primary-700"
        >
          {memberInitials(memberName)}
        </div>
        <h2 id="settlement-reauth-dialog-title" className="text-headline-2 text-text-primary">
          {t("settlement.reauth.title")}
        </h2>
      </header>

      <p id="settlement-reauth-dialog-body" className="text-body-2 text-text-secondary">
        {t("settlement.reauth.body", {
          memberFirstName: firstName,
          payout: formatFcfaAmount(expectedPayout),
        })}
      </p>

      <form className="flex flex-col gap-4" onSubmit={handleFormSubmit}>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="settlement-reauth-password-input"
            className="text-caption font-medium text-text-primary"
          >
            {t("settlement.reauth.password_label")}
          </label>
          <Input
            id="settlement-reauth-password-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (inlineError !== null) setInlineError(null);
            }}
            disabled={isMutating}
            aria-required="true"
          />
          {inlineError !== null ? (
            <p role="alert" className="text-body-2 text-destructive">
              {inlineError === "invalid"
                ? t("settlement.reauth.error.credentials_invalid")
                : t("settlement.reauth.error.rate_limited")}
            </p>
          ) : null}
        </div>

        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={password.trim().length === 0 || isMutating}
        >
          {isMutating ? t("settlement.reauth.cta_submitting") : t("settlement.reauth.cta_submit")}
        </Button>
      </form>

      <div className="flex flex-col gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={closeDialog}
          disabled={isMutating}
        >
          {t("settlement.reauth.cta_cancel")}
        </Button>
      </div>
    </div>
  );
}
