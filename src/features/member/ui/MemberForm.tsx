// Story 2.2 — MemberForm.
//
// Single-screen manual member creation. react-hook-form + Zod resolver.
// Pure presentation + mutation call — the parent route owns navigation
// (onSuccess / onCancel props). Same split as LoginForm (Story 1.5b).

import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";

import { useCreateMember, type CreateMemberErrorCode } from "../api/useCreateMember";
import { createMemberInputSchema, type CreateMemberInput } from "../types";

// `z.coerce.number()` has distinct input (unknown) and output (number) types;
// RHF must be told the raw input shape so `register()` + `defaultValues`
// stay string-friendly while the submit handler receives the coerced numbers.
type MemberFormInput = z.input<typeof createMemberInputSchema>;
type MemberFormOutput = CreateMemberInput;

export type MemberFormProps = {
  onSuccess: (memberId: string, values: CreateMemberInput) => void;
  onCancel: () => void;
};

/** Map an `useCreateMember` error code to the i18n key for the banner copy. */
function errorCopyKey(code: CreateMemberErrorCode): TranslationKey {
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

export function MemberForm({ onSuccess, onCancel }: MemberFormProps) {
  const t = useT();
  const createMember = useCreateMember();

  const form = useForm<MemberFormInput, unknown, MemberFormOutput>({
    resolver: zodResolver(createMemberInputSchema),
    // "onChange" keeps `formState.isValid` synced to the live state of the
    // three fields — avoids the "user hasn't blurred phone yet, so `isValid`
    // is false" trap that disables the CTA when phone is legitimately empty.
    mode: "onChange",
    defaultValues: {
      name: "",
      phoneNumber: "",
      dailyAmount: "",
    },
  });

  const canSubmit = form.formState.isValid && !createMember.isPending;

  const handleValid: SubmitHandler<MemberFormOutput> = async (values) => {
    try {
      const memberId = await createMember.mutateAsync(values);
      onSuccess(memberId, values);
    } catch {
      // Error lives on createMember.error — rendered as a banner below.
      // Do NOT rethrow; RHF is already done with its submission.
    }
  };

  const errorBannerKey = createMember.error !== null ? errorCopyKey(createMember.error.code) : null;

  return (
    <form
      onSubmit={form.handleSubmit(handleValid)}
      noValidate
      className="mx-auto flex w-full max-w-sm flex-col gap-6 p-4"
      aria-labelledby="member-form-title"
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 id="member-form-title" className="text-display text-primary-700">
          {t("members.create.title")}
        </h1>
        <p className="text-body-1 text-text-secondary">{t("members.create.subtitle")}</p>
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
          disabled={createMember.isPending}
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
          disabled={createMember.isPending}
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
          disabled={createMember.isPending}
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

      {errorBannerKey !== null ? (
        <p role="alert" className="text-body-2 text-destructive">
          {t(errorBannerKey)}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" disabled={!canSubmit} className="w-full">
          {createMember.isPending
            ? t("members.create.cta_submitting")
            : t("members.create.cta_submit")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={onCancel}
          disabled={createMember.isPending}
        >
          {t("members.create.cta_cancel")}
        </Button>
      </div>
    </form>
  );
}
