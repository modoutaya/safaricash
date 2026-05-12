// Story 6.6 — ResendHistoryDialog.
//
// Password-gated confirmation modal for FR33 full-cycle SMS history
// re-delivery. Built on the native <dialog> element (same pattern as
// DeleteMemberDialog from Story 2.6 — zero new deps).
//
// State machine:
//   "typing-password" — single step; user enters password and submits.
//
// On success (verify + enqueue returns {enqueued, reason}):
//   - Calls onSuccess(result); dialog closes; parent toasts.
//
// On credentials_invalid → clear password, inline alert, stay open.
// On rate_limited       → inline alert, stay open.
// On any other error    → calls onError(err); dialog closes; parent toasts.

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

import {
  useResendHistory,
  type ResendHistoryError,
  type ResendHistoryResult,
} from "../api/useResendHistory";
import { memberInitials } from "../api/memberInitials";

export interface ResendHistoryDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  memberId: string;
  cycleId: string;
  memberName: string;
  /** Called when the Edge Function returns 200 (regardless of reason). */
  onSuccess: (result: ResendHistoryResult) => void;
  /** Called for non-credential errors (network / 500 / unknown). */
  onError: (err: ResendHistoryError) => void;
}

type PasswordError = "invalid" | "rate_limited" | "unexpected" | null;

interface ResendHistoryDialogBodyProps extends Omit<
  ResendHistoryDialogProps,
  "open" | "onOpenChange"
> {
  closeDialog: () => void;
  setMutating: (next: boolean) => void;
}

function passwordErrorCopyKey(err: PasswordError): TranslationKey | null {
  switch (err) {
    case "invalid":
      return "members.profile.resend_history.password_invalid";
    case "rate_limited":
      return "members.profile.resend_history.password_rate_limited";
    case "unexpected":
      return "members.profile.resend_history.password_unexpected";
    case null:
    default:
      return null;
  }
}

export function ResendHistoryDialog(props: ResendHistoryDialogProps) {
  const { open, onOpenChange } = props;
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

  const closeDialog = () => onOpenChange(false);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      onCancel={(e) => {
        if (bodyMutating) e.preventDefault();
      }}
      aria-labelledby="resend-history-dialog-title"
      aria-describedby="resend-history-dialog-body"
      className="m-auto w-[90%] max-w-sm rounded-lg border border-neutral-200 bg-background p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      {open ? (
        <ResendHistoryDialogBody
          {...props}
          closeDialog={closeDialog}
          setMutating={setBodyMutating}
        />
      ) : null}
    </dialog>
  );
}

function ResendHistoryDialogBody({
  memberId,
  cycleId,
  memberName,
  onSuccess,
  onError,
  closeDialog,
  setMutating,
}: ResendHistoryDialogBodyProps) {
  const t = useT();
  const resend = useResendHistory();

  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<PasswordError>(null);

  const isMutating = resend.isPending;

  useEffect(() => {
    setMutating(isMutating);
  }, [isMutating, setMutating]);

  const handleSubmit = async () => {
    if (password.length === 0 || isMutating) return;
    setPasswordError(null);
    try {
      const result = await resend.mutateAsync({ memberId, cycleId, password });
      onSuccess(result);
      closeDialog();
    } catch (err) {
      const code = (err as ResendHistoryError).code;
      if (code === "credentials_invalid") {
        setPasswordError("invalid");
        setPassword("");
        return;
      }
      if (code === "rate_limited") {
        setPasswordError("rate_limited");
        setPassword("");
        return;
      }
      // Network / 500 / unknown — surface upstream and close.
      onError(err as ResendHistoryError);
      closeDialog();
    }
  };

  const passwordErrorKey = passwordErrorCopyKey(passwordError);

  // Code-review patch (P3): wrap input + primary CTA in <form> so Enter
  // submits the dialog. Cancel button stays type="button" outside the
  // form's submit semantics so it can't accidentally trigger submit.
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
        <h2 id="resend-history-dialog-title" className="text-headline-2 text-text-primary">
          {t("members.profile.resend_history.dialog_title")}
        </h2>
      </header>

      <p id="resend-history-dialog-body" className="text-body-2 text-text-secondary">
        {t("members.profile.resend_history.dialog_body")}
      </p>

      <form className="flex flex-col gap-4" onSubmit={handleFormSubmit}>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="resend-history-password-input"
            className="text-caption font-medium text-text-primary"
          >
            {t("members.profile.resend_history.password_input_label")}
          </label>
          <Input
            id="resend-history-password-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (passwordError !== null) setPasswordError(null);
            }}
            disabled={isMutating}
          />
          {passwordErrorKey !== null ? (
            <p role="alert" className="text-body-2 text-destructive">
              {t(passwordErrorKey)}
            </p>
          ) : null}
        </div>

        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={password.length === 0 || isMutating}
        >
          {isMutating
            ? t("members.profile.resend_history.cta_submitting")
            : t("members.profile.resend_history.cta_confirm")}
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
          {t("members.profile.resend_history.cancel")}
        </Button>
      </div>
    </div>
  );
}
