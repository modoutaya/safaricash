// Story 1.5b — LoginForm (single-screen phone + password).
//
// PRD v1.3 auth pivot. Replaces the Story 1.5 two-step phone → OTP flow
// with a single screen: phone field, password field with show/hide
// toggle, "Se connecter" CTA, and an inline "Mot de passe oublié ?"
// tel: link that funnels the founder-support recovery path (R-OP1).

import { useState } from "react";
import type { FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLogin } from "@/features/auth/api/useLogin";
import type { SignInResult } from "@/features/auth/api/useLogin";
import { FOUNDER_SUPPORT_PHONE, FOUNDER_SUPPORT_PHONE_DISPLAY } from "@/lib/contact";
import { useT } from "@/i18n/useT";
import type { TranslationKey } from "@/i18n/keys";
import { formatE164, isValidSenegalPhone } from "@/features/auth/ui/phoneFormat";

export type { SignInResult };

export type LoginFormProps = {
  onSignedIn: (result: SignInResult) => void;
};

export function LoginForm({ onSignedIn }: LoginFormProps) {
  const t = useT();
  const login = useLogin();
  const [rawPhone, setRawPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [touched, setTouched] = useState(false);

  const normalized = formatE164(rawPhone);
  const phoneValid = isValidSenegalPhone(normalized);
  const passwordNonEmpty = password.length > 0;
  const canSubmit = phoneValid && passwordNonEmpty && !login.isPending;
  const showPhoneError = touched && !phoneValid && rawPhone.length > 0;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    const outcome = await login.signIn(rawPhone, password);
    if (outcome.kind === "ok") {
      onSignedIn(outcome);
    }
    // On "error" the hook sets login.error and the inline banner renders.
  }

  function errorCopyKey(code: NonNullable<typeof login.error>): TranslationKey {
    if (code === "rate_limited") return "errors.rate_limited";
    if (code === "network") return "reauth.error.network";
    return "errors.invalid_credentials";
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

      <div className="flex flex-col gap-2">
        <label htmlFor="login-password" className="text-caption font-medium text-text-primary">
          {t("login.password_label")}
        </label>
        <div className="relative">
          <Input
            id="login-password"
            name="password"
            type={passwordVisible ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            disabled={login.isPending}
            className="pr-12"
          />
          <button
            type="button"
            onClick={() => setPasswordVisible((v) => !v)}
            aria-label={t(passwordVisible ? "login.password_hide" : "login.password_show")}
            aria-pressed={passwordVisible}
            className="absolute inset-y-0 right-0 flex h-11 w-11 items-center justify-center text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            disabled={login.isPending}
          >
            {passwordVisible ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
          </button>
        </div>
      </div>

      {login.error && login.error !== "phone_invalid" ? (
        <p role="alert" className="text-body-2 text-destructive">
          {t(errorCopyKey(login.error))}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={!canSubmit} className="w-full">
        {login.isPending ? t("login.signing_in") : t("login.cta_sign_in")}
      </Button>

      <p className="text-center text-body-2 text-text-secondary">
        <a
          href={`tel:${FOUNDER_SUPPORT_PHONE}`}
          className="text-primary-700 underline underline-offset-4 hover:text-primary-800 focus-visible:text-primary-800"
        >
          {t("login.forgot_password")}
        </a>
        <span className="mx-2" aria-hidden>
          ·
        </span>
        <span>{t("login.forgot_password_help", { phone: FOUNDER_SUPPORT_PHONE_DISPLAY })}</span>
      </p>
    </form>
  );
}
