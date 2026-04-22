// Story 2.3 — Step 3 of 3: display per-row progress + retry-failed CTA.
//
// Receives the live `useImportMembers` results map. The parent route
// triggers `start()` once on mount and `retryFailed()` when this
// component's CTA is clicked. The full-success branch is parent-owned
// (it navigates to /members + fires a toast).

import type { TranslationKey } from "@/i18n/keys";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";

import { type ImportRowResult, type ImportSummary } from "../api/useImportMembers";
import { type CreateMemberErrorCode } from "../api/useCreateMember";
import { memberInitials } from "../api/memberInitials";
import { type PickedContact } from "./ContactsPickerStep";

export type ImportProgressStepProps = {
  contacts: PickedContact[];
  results: Map<number, ImportRowResult>;
  summary: ImportSummary;
  isRunning: boolean;
  onRetryFailed: () => void;
  onCancel: () => void;
};

function rowErrorCopyKey(code: CreateMemberErrorCode): TranslationKey {
  switch (code) {
    case "unauthorized":
      return "members.create.error.unauthorized";
    case "duplicate_phone":
      return "members.create.error.duplicate_phone";
    case "network":
      return "members.create.error.network";
    case "validation":
    case "unknown":
    default:
      return "members.create.error.unknown";
  }
}

export function ImportProgressStep({
  contacts,
  results,
  summary,
  isRunning,
  onRetryFailed,
  onCancel,
}: ImportProgressStepProps) {
  const t = useT();
  const failedCount = summary.failed;

  return (
    <section
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 pb-24"
      aria-labelledby="progress-title"
      aria-live="polite"
    >
      <header className="flex flex-col gap-2">
        <h1 id="progress-title" className="text-title-1 text-text-primary">
          {t("members.import.title")}
        </h1>
        <p className="text-body-2 text-text-secondary">
          {t("members.import.summary_progress", {
            ok: summary.ok,
            failed: summary.failed,
            total: summary.total,
          })}
        </p>
      </header>

      <ul className="flex flex-col gap-2" aria-label={t("members.import.title")}>
        {contacts.map((contact, index) => {
          const result = results.get(index) ?? { status: "pending" as const };
          const isOk = result.status === "ok";
          const isError = result.status === "error";
          return (
            <li
              key={contact.id}
              className="flex items-center gap-3 rounded-lg border border-hairline bg-card p-3"
            >
              <div
                aria-hidden
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-body-2 font-semibold text-primary-700"
              >
                {memberInitials(contact.name)}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="truncate text-body-1 font-medium text-text-primary">{contact.name}</p>
                {isError ? (
                  <p className="truncate text-body-2 text-destructive" role="alert">
                    {t(rowErrorCopyKey(result.code))}
                  </p>
                ) : (
                  <p className="truncate text-body-2 text-text-secondary">
                    {isOk
                      ? t("members.import.row_status_ok")
                      : t("members.import.row_status_pending")}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2 border-t border-hairline bg-background p-4 [padding-bottom:env(safe-area-inset-bottom)]">
        {failedCount > 0 ? (
          <Button
            type="button"
            size="lg"
            onClick={onRetryFailed}
            disabled={isRunning}
            className="w-full"
          >
            {t("members.import.cta_retry_failed", { n: failedCount })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onCancel}
          disabled={isRunning}
          className="w-full"
        >
          {t("members.import.cta_cancel")}
        </Button>
      </div>
    </section>
  );
}
