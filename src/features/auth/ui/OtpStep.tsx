// Story 1.5 — OtpStep (Flow 5 steps K–N).
//
// Renders the 6-digit OTP input, masked phone, Verify CTA, Resend CTA (with
// 30s cooldown), and locked banner once 3 strikes are consumed. The parent
// owns the `useLogin` state; we render from the passed-in `login` handle.
//
// The component is kept controlled so vitest can drive it without needing
// to emulate the SMS channel.

import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import type { UseLoginReturn } from "@/features/auth/api/useLogin";
import { maskPhone } from "@/features/auth/ui/phoneFormat";
import { useT } from "@/i18n/useT";
import { OTP_LOCKOUT_MINUTES } from "@/lib/constants";

export type OtpStepProps = {
  phone: string;
  onCancel: () => void;
  onSignedIn: (result: { userId: string; memberCount: number }) => void;
  login: UseLoginReturn;
};

export function OtpStep({ phone, onCancel, onSignedIn, login }: OtpStepProps) {
  const t = useT();
  const [otp, setOtp] = useState("");
  const locked = login.step === "locked";

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked || otp.length !== 6) return;
    const outcome = await login.verifyCode(otp);
    if (outcome.kind === "ok") {
      onSignedIn({ userId: outcome.userId, memberCount: outcome.memberCount });
    } else {
      // Clear the input so the user can re-enter cleanly (UX Flow 5 step N).
      setOtp("");
    }
  }

  async function handleChange(value: string) {
    setOtp(value);
    // Auto-submit when the 6th digit lands. Supabase verifyOtp is fast
    // enough (~200ms) that we do not need a debounce.
    if (value.length === 6 && !locked && !login.isPending) {
      const outcome = await login.verifyCode(value);
      if (outcome.kind === "ok") {
        onSignedIn({ userId: outcome.userId, memberCount: outcome.memberCount });
      } else {
        setOtp("");
      }
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="mx-auto flex w-full max-w-sm flex-col gap-6 p-4"
      aria-labelledby="otp-title"
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 id="otp-title" className="text-title-1 text-primary-700">
          {t("login.cta_verify")}
        </h1>
        <p className="text-body-1 text-text-secondary">
          {t("login.otp_subtitle", { phone: maskPhone(phone) })}
        </p>
      </header>

      <div className="flex justify-center">
        <InputOTP
          maxLength={6}
          value={otp}
          onChange={handleChange}
          disabled={locked || login.isPending}
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <InputOTPSlot key={i} index={i} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>

      {locked ? (
        <p role="alert" className="rounded-md bg-warning-bg p-3 text-body-2 text-warning-text">
          {t("reauth.error.locked", { minutes: OTP_LOCKOUT_MINUTES })}
        </p>
      ) : null}

      {!locked && login.error === "expired" ? (
        <p role="alert" className="text-body-2 text-destructive">
          {t("reauth.error.expired")}
        </p>
      ) : null}

      {!locked && login.error === "invalid" ? (
        <p role="alert" className="text-body-2 text-destructive">
          {t("reauth.error.invalid")}
        </p>
      ) : null}

      {!locked && login.error === "network" ? (
        <p role="alert" className="text-body-2 text-destructive">
          {t("reauth.error.network")}
        </p>
      ) : null}

      <Button
        type="submit"
        size="lg"
        disabled={locked || login.isPending || otp.length !== 6}
        className="w-full"
      >
        {login.isPending ? t("login.verifying_code") : t("login.cta_verify")}
      </Button>

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            void login.resendCode();
          }}
          disabled={locked || login.isPending || login.cooldownSecondsRemaining > 0}
        >
          {login.cooldownSecondsRemaining > 0
            ? t("login.cta_resend_cooldown", { seconds: login.cooldownSecondsRemaining })
            : t("login.cta_resend")}
        </Button>
        <Button type="button" variant="link" onClick={onCancel}>
          {t("login.non_registered_cta_back")}
        </Button>
      </div>
    </form>
  );
}
