// Story 9.3 / FR5 — password re-auth gate for the CSV export.
//
// Single-step password dialog (the export has no "type SUPPRIMER" step —
// it is not destructive). Mirrors DeleteMemberDialog's re-auth call:
// `supabase.functions.invoke("re-auth", …)`, branch on `error.context.status`.
// On a 200 re-auth the export runs (runCsvExport); the CSVs download and an
// audit event is recorded. A failed audit is non-fatal — the files already
// downloaded, so we surface a non-blocking warning toast (AC #13).

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/infrastructure/supabase/client";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

import { runCsvExport } from "../api/runCsvExport";

export interface CsvExportReauthDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

type PasswordError = "invalid" | "rate_limited" | "unexpected" | null;

function passwordErrorCopyKey(err: PasswordError): TranslationKey | null {
  switch (err) {
    case "invalid":
      return "settings.export.password_invalid";
    case "rate_limited":
      return "settings.export.password_rate_limited";
    case "unexpected":
      return "settings.export.password_unexpected";
    case null:
    default:
      return null;
  }
}

export function CsvExportReauthDialog({ open, onOpenChange }: CsvExportReauthDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      aria-labelledby="csv-export-dialog-title"
      aria-describedby="csv-export-dialog-summary"
      className="m-auto w-[90%] max-w-sm rounded-lg border border-neutral-200 bg-background p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      {/* Mount the body only when open — fresh useState defaults each open. */}
      {open ? (
        <CsvExportReauthDialogBody closeDialog={() => onOpenChange(false)} setMutating={setBusy} />
      ) : null}
    </dialog>
  );
}

interface CsvExportReauthDialogBodyProps {
  closeDialog: () => void;
  setMutating: (next: boolean) => void;
}

function CsvExportReauthDialogBody({ closeDialog, setMutating }: CsvExportReauthDialogBodyProps) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<PasswordError>(null);
  const [phase, setPhase] = useState<"idle" | "reauthing" | "exporting">("idle");

  const isMutating = phase !== "idle";

  // Bubble the mutating state up so the dialog can block ESC mid-export.
  useEffect(() => {
    setMutating(isMutating);
  }, [isMutating, setMutating]);

  const handleSubmit = async () => {
    if (password.length === 0 || isMutating) return;
    setPasswordError(null);
    setPhase("reauthing");
    try {
      const { error } = await supabase.functions.invoke("re-auth", {
        body: { password, operation_intent: "csv_export" },
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
        setPhase("idle");
        return;
      }
    } catch {
      setPasswordError("unexpected");
      setPassword("");
      setPhase("idle");
      return;
    }

    // Re-auth passed → run the export.
    setPhase("exporting");
    try {
      const result = await runCsvExport();
      if (result.auditFailed) {
        toast.warning(t("settings.export.toast_audit_warning"));
      } else {
        toast.success(t("settings.export.toast_success"));
      }
      closeDialog();
    } catch {
      toast.error(t("settings.export.toast_failure"));
      // Dialog stays open so the user can retry — the password field is
      // kept so they need not re-type it after a transient fetch failure.
      setPhase("idle");
    }
  };

  const passwordErrorKey = passwordErrorCopyKey(passwordError);

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h2 id="csv-export-dialog-title" className="text-headline-2 text-text-primary">
          {t("settings.export.dialog_title")}
        </h2>
        <p id="csv-export-dialog-summary" className="text-body-2 text-text-secondary">
          {t("settings.export.dialog_summary")}
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="csv-export-password-input"
          className="text-caption font-medium text-text-primary"
        >
          {t("settings.export.password_input_label")}
        </label>
        <Input
          id="csv-export-password-input"
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
          className="w-full"
          onClick={handleSubmit}
          disabled={password.length === 0 || isMutating}
        >
          {isMutating ? t("settings.export.submitting") : t("settings.export.submit_cta")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={closeDialog}
          disabled={isMutating}
        >
          {t("settings.export.cancel")}
        </Button>
      </div>
    </div>
  );
}
