// Story 2.6 — DeleteMemberDialog.
//
// 2-step destructive confirmation modal hosting the password re-auth call
// and the useDeleteMember mutation. Built on the native <dialog> element
// (same pattern as RestartCycleDialog from Story 2.7 — zero new deps).
//
// State machine:
//   "typing-confirmation" — user must type SUPPRIMER (case-insensitive).
//   "typing-password"     — user enters password; we POST to /functions/v1/
//                           re-auth, then on 200 OK call delete_member RPC.
//
// On success → onSuccess(memberId) (parent toasts + navigates).
// On 401 password → clear password input, show inline alert, stay open.
// On 429 password → show rate-limited inline alert, stay open.
// On RPC failure post-re-auth → toast via parent + dialog stays open so
//   the user can retry without re-typing SUPPRIMER OR password.

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/infrastructure/supabase/client";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

import { useDeleteMember } from "../api/useDeleteMember";
import { memberInitials } from "../api/memberInitials";

export interface DeleteMemberDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  memberId: string;
  memberName: string;
  /** Total transactions across all cycles (current + previous). */
  transactionsCount: number;
  /** Current + previous cycles count. */
  cyclesCount: number;
  /** Called after the mutation resolves successfully. */
  onSuccess: (memberId: string) => void;
  /** Called after the mutation fails post-re-auth (caller toasts). */
  onMutationFailure: () => void;
}

type Step = "typing-confirmation" | "typing-password";
type PasswordError = "invalid" | "rate_limited" | "unexpected" | null;

interface DeleteMemberDialogBodyProps extends Omit<
  DeleteMemberDialogProps,
  "open" | "onOpenChange"
> {
  closeDialog: () => void;
  setMutating: (next: boolean) => void;
}

const SUPPRIMER_WORD = "SUPPRIMER";

function isSuppressionWordTyped(value: string): boolean {
  return value.trim().toUpperCase() === SUPPRIMER_WORD;
}

function passwordErrorCopyKey(err: PasswordError): TranslationKey | null {
  switch (err) {
    case "invalid":
      return "members.profile.delete.password_invalid";
    case "rate_limited":
      return "members.profile.delete.password_rate_limited";
    case "unexpected":
      return "members.profile.delete.password_unexpected";
    case null:
    default:
      return null;
  }
}

export function DeleteMemberDialog(props: DeleteMemberDialogProps) {
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
      aria-labelledby="delete-member-dialog-title"
      aria-describedby="delete-member-dialog-summary"
      className="m-auto w-[90%] max-w-sm rounded-lg border border-neutral-200 bg-background p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      {/* Mount the body only when open — fresh useState defaults each open
          avoids the eslint-flagged setState-in-effect reset pattern. */}
      {open ? (
        <DeleteMemberDialogBody
          {...props}
          closeDialog={closeDialog}
          setMutating={setBodyMutating}
        />
      ) : null}
    </dialog>
  );
}

function DeleteMemberDialogBody({
  memberId,
  memberName,
  transactionsCount,
  cyclesCount,
  onSuccess,
  onMutationFailure,
  closeDialog,
  setMutating,
}: DeleteMemberDialogBodyProps) {
  const t = useT();
  const deleteMember = useDeleteMember();

  const [step, setStep] = useState<Step>("typing-confirmation");
  const [confirmationInput, setConfirmationInput] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<PasswordError>(null);
  const [reauthSubmitting, setReauthSubmitting] = useState(false);

  const isMutating = reauthSubmitting || deleteMember.isPending;

  // Bubble the mutating state up so the parent dialog can prevent ESC.
  useEffect(() => {
    setMutating(isMutating);
  }, [isMutating, setMutating]);

  const summaryCopy =
    transactionsCount === 0
      ? t("members.profile.delete.dialog_summary_zero", { m: cyclesCount })
      : t("members.profile.delete.dialog_summary", { n: transactionsCount, m: cyclesCount });

  const handleAdvanceToPassword = () => {
    if (!isSuppressionWordTyped(confirmationInput)) return;
    setStep("typing-password");
  };

  const handleSubmitDelete = async () => {
    if (password.length === 0 || isMutating) return;
    setPasswordError(null);
    setReauthSubmitting(true);
    try {
      const { error } = await supabase.functions.invoke("re-auth", {
        body: { password, operation_intent: "member_delete" },
      });
      if (error) {
        // FunctionsHttpError.context is the upstream Response.
        const ctx = (error as { context?: Response | { status?: number } }).context;
        const status =
          typeof ctx === "object" && ctx !== null && "status" in ctx
            ? (ctx as { status?: number }).status
            : undefined;
        if (status === 429) setPasswordError("rate_limited");
        else if (status === 401) setPasswordError("invalid");
        else setPasswordError("unexpected");
        setPassword("");
        return;
      }
    } catch {
      setPasswordError("unexpected");
      setPassword("");
      return;
    } finally {
      setReauthSubmitting(false);
    }

    // Re-auth passed → fire the delete RPC.
    try {
      await deleteMember.mutateAsync(memberId);
      onSuccess(memberId);
      closeDialog();
    } catch {
      onMutationFailure();
      // Dialog stays open so the user can retry — the SUPPRIMER step is
      // already satisfied, only the password field is cleared above.
    }
  };

  const passwordErrorKey = passwordErrorCopyKey(passwordError);

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-100 text-title-2 font-semibold text-primary-700"
        >
          {memberInitials(memberName)}
        </div>
        <h2 id="delete-member-dialog-title" className="text-headline-2 text-text-primary">
          {memberName}
        </h2>
      </header>

      <p id="delete-member-dialog-summary" className="text-body-2 text-text-secondary">
        {summaryCopy}
      </p>

      <p className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body-2 text-destructive">
        {t("members.profile.delete.dialog_warning")}
      </p>

      {step === "typing-confirmation" ? (
        <>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="delete-confirmation-input"
              className="text-caption font-medium text-text-primary"
            >
              {t("members.profile.delete.confirmation_input_label")}
            </label>
            <Input
              id="delete-confirmation-input"
              type="text"
              autoComplete="off"
              value={confirmationInput}
              onChange={(e) => setConfirmationInput(e.target.value)}
              aria-label={t("members.profile.delete.confirmation_input_label")}
            />
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={handleAdvanceToPassword}
              disabled={!isSuppressionWordTyped(confirmationInput)}
            >
              {t("members.profile.delete.confirmation_continue")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full"
              onClick={closeDialog}
            >
              {t("members.profile.delete.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-body-2 text-text-secondary">
            ✓ {t("members.profile.delete.confirmation_input_label")}
          </p>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="delete-password-input"
              className="text-caption font-medium text-text-primary"
            >
              {t("members.profile.delete.password_input_label")}
            </label>
            <Input
              id="delete-password-input"
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

          <div className="flex flex-col gap-2 pt-2">
            <Button
              type="button"
              size="lg"
              variant="destructive"
              className="w-full"
              onClick={handleSubmitDelete}
              disabled={password.length === 0 || isMutating}
            >
              {isMutating
                ? t("members.profile.delete.cta_submitting")
                : t("members.profile.delete.final_cta")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full"
              onClick={closeDialog}
              disabled={isMutating}
            >
              {t("members.profile.delete.cancel")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
