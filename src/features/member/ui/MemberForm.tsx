// Story 2.2 → 2.5 — MemberForm.
//
// Mode-driven presentation component. Routes own the mutation hook
// (useCreateMember from /new, useUpdateMember from /:id/edit) and pass
// the result via `onSubmit`, `isPending`, `errorCode`. The form's
// validation surface (Zod resolver, `mode: "onChange"`) is unchanged
// since Story 2.2 — both create and edit re-use createMemberInputSchema.
//
// Layout follows the design mockup (03-mockups.html — Ajouter Membre):
// a green header, a white "Informations personnelles" section card, and
// — in create mode — a live cycle recap. The header uses primary-700 so
// the white text clears WCAG AA contrast (the axe E2E gates this page).

import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";
import { useEffect } from "react";
import { useForm, useWatch, type SubmitHandler } from "react-hook-form";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { commission, cycleLengthDays, deriveCycleBounds } from "@/domain/cycle";
import type { TranslationKey } from "@/i18n/keys";
import { useT } from "@/i18n/useT";

import { formatFcfaAmount } from "../api/formatAmount";
import type { CreateMemberErrorCode } from "../api/useCreateMember";
import type { UpdateMemberErrorCode } from "../api/useUpdateMember";
import { createMemberInputSchema, type CreateMemberInput } from "../types";

type MemberFormInput = z.input<typeof createMemberInputSchema>;
type MemberFormOutput = CreateMemberInput;

export type MemberFormMode = "create" | "edit";

export type MemberFormErrorCode = CreateMemberErrorCode | UpdateMemberErrorCode;

export interface MemberFormProps {
  mode: MemberFormMode;
  initialValues?: CreateMemberInput;
  onSubmit: (values: CreateMemberInput) => Promise<void>;
  onCancel: () => void;
  isPending: boolean;
  errorCode: MemberFormErrorCode | null;
  /** Optional render-prop slot rendered between the form fields and the
   *  Save CTA. Story 2.5 uses this for the in-flight cycle warning. */
  belowFields?: (state: { values: CreateMemberInput; isDirty: boolean }) => React.ReactNode;
}

function errorCopyKey(mode: MemberFormMode, code: MemberFormErrorCode): TranslationKey {
  if (mode === "edit") {
    switch (code) {
      case "unauthorized":
        return "members.edit.error.unauthorized";
      case "duplicate_phone":
        return "members.edit.error.duplicate_phone";
      case "not_found":
        return "members.edit.error.not_found";
      case "network":
        return "members.edit.error.network";
      case "offline_storage":
        return "members.edit.error.offline_storage";
      case "validation":
      case "unknown":
      default:
        return "members.edit.error.unknown";
    }
  }
  switch (code) {
    case "unauthorized":
      return "members.create.error.unauthorized";
    case "duplicate_phone":
      return "members.create.error.duplicate_phone";
    case "network":
      return "members.create.error.network";
    case "validation":
    case "not_found":
    case "unknown":
    default:
      return "members.create.error.unknown";
  }
}

const EMPTY_DEFAULTS: MemberFormInput = {
  name: "",
  phoneNumber: "",
  dailyAmount: "",
};

/** Live cycle recap (create mode) — mirrors 03-mockups.html .preview-card.
 *  The new member's first cycle is the calendar-month cycle derived from
 *  today's date (Story 11.2 — variable length), so the recap previews the
 *  actual cycle the member will get. */
function CycleRecap({ name, dailyAmount }: { name: string; dailyAmount: number }): JSX.Element {
  const t = useT();
  const amount = (value: number): string =>
    t("members.create.recap.amount", { amount: formatFcfaAmount(value) });
  const { startDate, endDate } = deriveCycleBounds(new Date().toISOString().slice(0, 10));
  const cycleLength = cycleLengthDays(startDate, endDate);
  const rows: ReadonlyArray<{ label: string; value: string }> = [
    { label: t("members.create.recap.row_member"), value: name },
    { label: t("members.create.recap.row_contribution"), value: amount(dailyAmount) },
    { label: t("members.create.recap.row_total"), value: amount(dailyAmount * cycleLength) },
    { label: t("members.create.recap.row_commission"), value: amount(commission(dailyAmount)) },
    {
      label: t("members.create.recap.row_repayment"),
      // Story 12.5 PR C — the create-member recap is a theoretical
      // teaser ("si le saver cotise daily × cycleLength chaque jour,
      // il recevra ce montant à la fin"). The new currentBalance is
      // a runtime value (contributedTotal − …) and is meaningless
      // before the first contribution, so we keep the legacy
      // `daily × (cycleLength − 1)` math inline as the teaser.
      value: amount(dailyAmount * (cycleLength - 1)),
    },
  ];
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-primary-200 bg-primary-50 p-4">
      <h2 className="text-title-2 text-primary-700">{t("members.create.recap.title")}</h2>
      <dl className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 truncate text-body-2 text-text-secondary">{row.label}</dt>
            <dd
              className="shrink-0 text-body-2 font-semibold text-primary-700"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function MemberForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isPending,
  errorCode,
  belowFields,
}: MemberFormProps) {
  const t = useT();

  const defaults: MemberFormInput = initialValues
    ? {
        name: initialValues.name,
        phoneNumber: initialValues.phoneNumber,
        // RHF input shape expects a string for the number field (z.coerce).
        dailyAmount: String(initialValues.dailyAmount),
      }
    : EMPTY_DEFAULTS;

  const form = useForm<MemberFormInput, unknown, MemberFormOutput>({
    resolver: zodResolver(createMemberInputSchema),
    mode: "onChange",
    defaultValues: defaults,
  });

  // Keep RHF defaults in sync if `initialValues` lands after the first
  // render (e.g. /:id/edit hydrating from useMemberProfile). Unconditional
  // reset would clobber user keystrokes; gate on the JSON snapshot of
  // initialValues so we only reset when the source data actually changes.
  // form.trigger() forces validation on all fields immediately — without
  // it, RHF's `mode: "onChange"` waits for the FIRST field change before
  // running async (zodResolver) validation, leaving formState.isValid
  // stuck at false and the Save CTA permanently disabled in edit mode
  // (caught by the Story 2.5 Playwright run).
  const initialKey = initialValues ? JSON.stringify(initialValues) : "__none__";
  useEffect(() => {
    if (initialValues) {
      form.reset({
        name: initialValues.name,
        phoneNumber: initialValues.phoneNumber,
        dailyAmount: String(initialValues.dailyAmount),
      });
      void form.trigger();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const dirtyEnabled = mode === "edit" ? form.formState.isDirty : true;
  const canSubmit = form.formState.isValid && dirtyEnabled && !isPending;

  const handleValid: SubmitHandler<MemberFormOutput> = async (values) => {
    try {
      await onSubmit(values);
    } catch {
      // The owning route surfaces the error via `errorCode` — re-throwing
      // would crash RHF, which has already released the submission.
    }
  };

  const errorBannerKey = errorCode !== null ? errorCopyKey(mode, errorCode) : null;
  const titleKey: TranslationKey = mode === "edit" ? "members.edit.title" : "members.create.title";
  const subtitleKey: TranslationKey | null = mode === "edit" ? null : "members.create.subtitle";
  // Story 11.4 — preview the first cycle's actual length (calendar-month
  // aligned via deriveCycleBounds) so the subtitle reflects the variable
  // cycle the new saver will actually get, not a hardcoded "30 jours".
  const firstCycleBounds = deriveCycleBounds(new Date().toISOString().slice(0, 10));
  const firstCycleLength = cycleLengthDays(firstCycleBounds.startDate, firstCycleBounds.endDate);
  const submitKey: TranslationKey = isPending
    ? mode === "edit"
      ? "members.edit.cta_submitting"
      : "members.create.cta_submitting"
    : mode === "edit"
      ? "members.edit.cta_submit"
      : "members.create.cta_submit";

  // Subscribe to the form values for the optional below-fields render-prop
  // slot. useWatch is the eslint-blessed alternative to form.watch().
  const watched = useWatch({ control: form.control });
  const slotValues: CreateMemberInput = {
    name: watched.name ?? "",
    phoneNumber: watched.phoneNumber ?? "",
    dailyAmount: Number(watched.dailyAmount) || 0,
  };
  const showRecap = mode === "create" && slotValues.dailyAmount >= 100;

  return (
    <form
      onSubmit={form.handleSubmit(handleValid)}
      noValidate
      className="mx-auto flex w-full max-w-2xl flex-col"
      aria-labelledby="member-form-title"
    >
      {/* Full-bleed green topbar — primary-700 keeps the white text WCAG AA
          on contrast (the mockup's lighter gradient would fail the axe E2E). */}
      <header className="flex flex-col gap-1 bg-primary-700 px-4 pb-6 pt-4 text-primary-foreground">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="-ml-1 inline-flex w-fit items-center gap-1 rounded-md py-1 pl-1 pr-2 text-body-2 text-primary-foreground/90 hover:text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground disabled:opacity-50"
        >
          <X aria-hidden className="h-4 w-4 shrink-0" />
          {t("members.create.cta_cancel")}
        </button>
        <h1 id="member-form-title" className="text-title-1">
          {t(titleKey)}
        </h1>
        {subtitleKey ? (
          <p className="text-body-2 text-primary-foreground/90">
            {t(subtitleKey, { total: firstCycleLength })}
          </p>
        ) : null}
      </header>

      <div className="flex flex-col gap-4 p-4">
        {/* "Informations personnelles" section card. */}
        <section className="flex flex-col gap-4 rounded-lg border border-hairline bg-card p-4">
          <h2 className="text-title-2 text-text-primary">{t("members.create.section_title")}</h2>

          {/* Name */}
          <div className="flex flex-col gap-2">
            <label htmlFor="member-name" className="text-caption font-medium text-text-primary">
              {t("members.create.field.name_label")}
            </label>
            <Input
              id="member-name"
              type="text"
              autoComplete="name"
              placeholder={t("members.create.field.name_placeholder")}
              disabled={isPending}
              aria-invalid={form.formState.errors.name ? true : undefined}
              aria-describedby={form.formState.errors.name ? "member-name-error" : undefined}
              {...form.register("name")}
            />
            {form.formState.errors.name ? (
              <p id="member-name-error" role="alert" className="text-body-2 text-destructive">
                {form.formState.errors.name.message}
              </p>
            ) : null}
          </div>

          {/* Phone (required) */}
          <div className="flex flex-col gap-2">
            <label htmlFor="member-phone" className="text-caption font-medium text-text-primary">
              {t("members.create.field.phone_label")}
            </label>
            <Input
              id="member-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t("members.create.field.phone_placeholder")}
              disabled={isPending}
              aria-invalid={form.formState.errors.phoneNumber ? true : undefined}
              aria-describedby={
                form.formState.errors.phoneNumber ? "member-phone-error" : undefined
              }
              {...form.register("phoneNumber")}
            />
            {form.formState.errors.phoneNumber ? (
              <p id="member-phone-error" role="alert" className="text-body-2 text-destructive">
                {form.formState.errors.phoneNumber.message}
              </p>
            ) : null}
          </div>

          {/* Daily amount */}
          <div className="flex flex-col gap-2">
            <label htmlFor="member-amount" className="text-caption font-medium text-text-primary">
              {t("members.create.field.amount_label")}
            </label>
            <Input
              id="member-amount"
              type="number"
              inputMode="numeric"
              min={100}
              max={100000}
              step={1}
              disabled={isPending}
              aria-invalid={form.formState.errors.dailyAmount ? true : undefined}
              aria-describedby={
                form.formState.errors.dailyAmount ? "member-amount-error" : "member-amount-helper"
              }
              {...form.register("dailyAmount")}
            />
            {form.formState.errors.dailyAmount ? (
              <p id="member-amount-error" role="alert" className="text-body-2 text-destructive">
                {form.formState.errors.dailyAmount.message}
              </p>
            ) : (
              <p id="member-amount-helper" className="text-body-2 text-text-secondary">
                {t("members.create.field.amount_helper")}
              </p>
            )}
          </div>
        </section>

        {showRecap ? (
          <CycleRecap name={slotValues.name} dailyAmount={slotValues.dailyAmount} />
        ) : null}

        {belowFields ? belowFields({ values: slotValues, isDirty: form.formState.isDirty }) : null}

        {errorBannerKey !== null ? (
          <p role="alert" className="text-body-2 text-destructive">
            {t(errorBannerKey)}
          </p>
        ) : null}

        <Button type="submit" size="lg" disabled={!canSubmit} className="w-full">
          {t(submitKey)}
        </Button>
      </div>
    </form>
  );
}
