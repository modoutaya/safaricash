// Story 1.5 — LoginForm (Flow 5 step B).
//
// Welcome screen: copy "Bienvenue sur SafariCash. Entrez votre numéro pour
// continuer.", one phone input, one primary CTA "Recevoir le code".
// No "Remember me", no social logins, no email fallback.
//
// On successful send → in-place transition to <OtpStep/>. On non-registered
// → navigate to /non-registered (router concern, surfaced via
// `onNonRegistered` prop — the hook layer should not know about routes).

import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLogin } from "@/features/auth/api/useLogin";
import { useT } from "@/i18n/useT";
import { formatE164, isValidSenegalPhone } from "@/features/auth/ui/phoneFormat";

import { OtpStep } from "./OtpStep";
import type { SignedInResult } from "./OtpStep";

export type LoginFormProps = {
  onNonRegistered: (phone: string) => void;
  onSignedIn: (result: SignedInResult) => void;
};

export function LoginForm({ onNonRegistered, onSignedIn }: LoginFormProps) {
  const t = useT();
  const login = useLogin();
  const [rawPhone, setRawPhone] = useState("");
  const [touched, setTouched] = useState(false);

  const normalized = formatE164(rawPhone);
  const phoneValid = isValidSenegalPhone(normalized);
  const showPhoneError = touched && !phoneValid && rawPhone.length > 0;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    if (!phoneValid) return;
    const outcome = await login.sendCode(rawPhone);
    if (outcome.kind === "not_registered") {
      onNonRegistered(outcome.phone);
    }
    // On "registered", the hook flips step to "otp" and OtpStep renders below.
    // On "error", the hook sets `login.error` and we render the inline banner.
  }

  if (login.step === "otp" || login.step === "locked") {
    return (
      <OtpStep
        phone={login.phone}
        onCancel={() => login.reset()}
        onSignedIn={onSignedIn}
        login={login}
      />
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="mx-auto flex w-full max-w-sm flex-col gap-6 p-4"
      aria-labelledby="login-title"
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 id="login-title" className="text-display text-primary-700">
          {t("login.welcome_title")}
        </h1>
        <p className="text-body-1 text-text-secondary">{t("login.welcome_subtitle")}</p>
      </header>

      <div className="flex flex-col gap-2">
        <label htmlFor="login-phone" className="text-caption font-medium text-text-primary">
          {t("login.phone_label")}
        </label>
        <Input
          id="login-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder={t("login.phone_placeholder")}
          value={rawPhone}
          onChange={(e) => setRawPhone(e.currentTarget.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showPhoneError || undefined}
          aria-describedby={showPhoneError ? "login-phone-error" : undefined}
          disabled={login.isPending}
        />
        {showPhoneError ? (
          <p id="login-phone-error" role="alert" className="text-body-2 text-destructive">
            {t("login.phone_invalid")}
          </p>
        ) : null}
      </div>

      {login.error && login.error !== "phone_invalid" ? (
        <p role="alert" className="text-body-2 text-destructive">
          {t(
            login.error === "delivery_failed"
              ? "reauth.error.delivery_failed"
              : login.error === "network"
                ? "reauth.error.network"
                : "reauth.error.invalid",
          )}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={!phoneValid || login.isPending} className="w-full">
        {login.isPending ? t("login.sending_code") : t("login.cta_send_code")}
      </Button>
    </form>
  );
}
