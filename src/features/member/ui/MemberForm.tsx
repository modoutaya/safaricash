// Story 2.2 → 2.5 — MemberForm.
//
// Mode-driven presentation component. Routes own the mutation hook
// (useCreateMember from /new, useUpdateMember from /:id/edit) and pass
// the result via `onSubmit`, `isPending`, `errorCode`. The form's
// validation surface (Zod resolver, `mode: "onChange"`) is unchanged
// since Story 2.2 — both create and edit re-use createMemberInputSchema.

import { useEffect } from "react";
import { useForm, useWatch, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

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

  return (
    <form
      onSubmit={form.handleSubmit(handleValid)}
      noValidate
      className="mx-auto flex w-full max-w-sm flex-col gap-6 p-4"
      aria-labelledby="member-form-title"
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 id="member-form-title" className="text-display text-primary-700">
          {t(titleKey)}
        </h1>
        {subtitleKey ? <p className="text-body-1 text-text-secondary">{t(subtitleKey)}</p> : null}
      </header>

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

      {/* Phone (optional) */}
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
          aria-describedby={form.formState.errors.phoneNumber ? "member-phone-error" : undefined}
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

      {belowFields ? belowFields({ values: slotValues, isDirty: form.formState.isDirty }) : null}

      {errorBannerKey !== null ? (
        <p role="alert" className="text-body-2 text-destructive">
          {t(errorBannerKey)}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" disabled={!canSubmit} className="w-full">
          {t(submitKey)}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={onCancel}
          disabled={isPending}
        >
          {t("members.create.cta_cancel")}
        </Button>
      </div>
    </form>
  );
}
