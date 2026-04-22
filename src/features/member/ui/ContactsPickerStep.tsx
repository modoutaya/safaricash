// Story 2.3 — Step 2 of 3: assign daily amount per picked contact.
//
// Pure presentation: parent owns state transitions. Receives the OS
// picker's resolved contacts as PickedContact[], emits the validated
// ImportRow[] on confirm.

import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n/useT";
import { formatE164, isValidSenegalPhone } from "@/features/auth/ui/phoneFormat";

import { memberInitials } from "../api/memberInitials";
import { type ImportRow } from "../api/useImportMembers";

/** Shape of a picked contact post-OS-picker, pre-amount-assign. */
export type PickedContact = {
  /** Local-only id for React keys (the OS picker doesn't return one). */
  id: string;
  name: string;
  /** First phone normalized to E.164 — empty string if absent or invalid. */
  phone: string;
};

export type ContactsPickerStepProps = {
  contacts: PickedContact[];
  onConfirm: (rows: ImportRow[]) => void;
  onCancel: () => void;
};

type RowState = {
  contact: PickedContact;
  /** String to allow empty / invalid input via RHF-free local state. */
  amount: string;
  removed: boolean;
};

/** Tight per-row validator — mirrors createMemberInputSchema rules. */
function isRowValid(row: RowState): boolean {
  if (row.removed) return true; // removed rows don't count
  if (row.contact.name.trim().length < 2) return false;
  const n = Number(row.amount);
  if (!Number.isInteger(n)) return false;
  if (n < 100 || n > 100000) return false;
  return true;
}

export function ContactsPickerStep({ contacts, onConfirm, onCancel }: ContactsPickerStepProps) {
  const t = useT();
  const [rows, setRows] = useState<RowState[]>(() =>
    contacts.map((c) => ({ contact: c, amount: "", removed: false })),
  );

  const visibleRows = useMemo(() => rows.filter((r) => !r.removed), [rows]);
  const allValid = visibleRows.length > 0 && visibleRows.every(isRowValid);

  function updateAmount(index: number, value: string): void {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, amount: value } : r)));
  }

  function removeRow(index: number): void {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, removed: true } : r)));
  }

  function applyToAll(): void {
    const firstActive = rows.find((r) => !r.removed && r.amount !== "");
    if (!firstActive) return;
    setRows((prev) => prev.map((r) => (r.removed ? r : { ...r, amount: firstActive.amount })));
  }

  function handleConfirm(): void {
    if (!allValid) return;
    const importRows: ImportRow[] = visibleRows.map((r) => ({
      name: r.contact.name.trim(),
      // The phone has already been normalized at picker-result time; if it
      // didn't match, it's an empty string.
      phoneNumber:
        r.contact.phone === ""
          ? ""
          : isValidSenegalPhone(formatE164(r.contact.phone))
            ? formatE164(r.contact.phone)
            : "",
      dailyAmount: Number(r.amount),
    }));
    onConfirm(importRows);
  }

  return (
    <section
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 pb-24"
      aria-labelledby="picker-title"
    >
      <header className="flex flex-col gap-2">
        <h1 id="picker-title" className="text-title-1 text-text-primary">
          {t("members.import.title")}
        </h1>
        <p className="text-body-2 text-text-secondary">
          {t("members.import.picker_subtitle", { n: visibleRows.length })}
        </p>
      </header>

      <Button
        type="button"
        variant="outline"
        onClick={applyToAll}
        disabled={visibleRows.length === 0 || !visibleRows[0]?.amount}
        className="w-full"
        aria-describedby="bulk-apply-helper"
      >
        {t("members.import.bulk_apply_label")}
      </Button>
      <p id="bulk-apply-helper" className="text-body-2 text-text-secondary">
        {t("members.import.bulk_apply_helper")}
      </p>

      <ul className="flex flex-col gap-2" aria-label={t("members.import.title")}>
        {rows.map((row, index) => {
          if (row.removed) return null;
          const inputId = `picker-amount-${index}`;
          return (
            <li
              key={row.contact.id}
              className="flex items-center gap-3 rounded-lg border border-hairline bg-card p-3"
            >
              <div
                aria-hidden
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-body-2 font-semibold text-primary-700"
              >
                {memberInitials(row.contact.name)}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="truncate text-body-1 font-medium text-text-primary">
                  {row.contact.name}
                </p>
                {row.contact.phone ? (
                  <p className="truncate text-body-2 text-text-secondary">{row.contact.phone}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor={inputId} className="sr-only">
                  {t("members.import.row_amount_label")}
                </label>
                <Input
                  id={inputId}
                  type="number"
                  inputMode="numeric"
                  min={100}
                  max={100000}
                  step={1}
                  value={row.amount}
                  onChange={(e) => updateAmount(index, e.currentTarget.value)}
                  className="w-24"
                  placeholder="500"
                />
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  aria-label={t("members.import.row_remove_label")}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                >
                  <X size={20} aria-hidden />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2 border-t border-hairline bg-background p-4 [padding-bottom:env(safe-area-inset-bottom)]">
        <Button
          type="button"
          size="lg"
          disabled={!allValid}
          onClick={handleConfirm}
          className="w-full"
        >
          {t("members.import.cta_confirm", { n: visibleRows.length })}
        </Button>
        <Button type="button" variant="outline" size="lg" onClick={onCancel} className="w-full">
          {t("members.import.cta_cancel")}
        </Button>
      </div>
    </section>
  );
}
