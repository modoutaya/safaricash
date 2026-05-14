// Story 7.2 / UX-DR10 — envelope handover screen (epics.md:1113-1119).
// Day-30 emotional climax: pure presentation atom for the "moment of
// crystallised trust" (ux-design-specification.md § 6, lines 1129-1156).
// Pride over playfulness — zero decorative animation; one mount-time
// programmatic focus on the CTA per UX line 1152.

import { useEffect, useRef } from "react";

import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

export interface EnvelopeHandoverScreenProps {
  /** Display name; spec body interpolates `memberName` verbatim. */
  memberName: string;
  /** FCFA integer (positive). Spec mandates `formatFcfaAmount` rendering. */
  payoutAmount: number;
  /** Saver's phone — used in the subtext when present. `null` → subtext is hidden entirely. */
  recipientPhone: string | null;
  /** Default = "sent". When "pending", subtext copy switches to *"Envoi du récapitulatif…"* + a spinner. */
  smsState?: "pending" | "sent";
  /** Single-callback CTA. Route owns navigation. */
  onReturnToMembers: () => void;
  className?: string;
}

export function EnvelopeHandoverScreen({
  memberName,
  payoutAmount,
  recipientPhone,
  smsState = "sent",
  onReturnToMembers,
  className,
}: EnvelopeHandoverScreenProps): JSX.Element {
  const t = useT();
  // UX spec line 1152 — focus lands on CTA by default. Programmatic focus
  // via useRef + useEffect; we don't use the autoFocus HTML attribute
  // because the project enforces jsx-a11y/no-autofocus (.eslintrc.cjs:56).
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    ctaRef.current?.focus();
  }, []);

  // AC #4 — three-config subtext: null → omit; pending → spinner+copy; sent → phone copy.
  const subtextEl =
    recipientPhone === null ? null : smsState === "pending" ? (
      <p
        aria-live="polite"
        className="flex items-center justify-center gap-2 text-center text-body-2 text-text-secondary"
      >
        <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
        {t("envelope_handover.subtext_pending")}
      </p>
    ) : (
      <p aria-live="polite" className="text-center text-body-2 text-text-secondary">
        {t("envelope_handover.subtext_sent", { phone: recipientPhone })}
      </p>
    );

  return (
    <section
      className={cn(
        "mx-auto flex max-w-md flex-col items-center justify-center gap-6 p-6",
        className,
      )}
    >
      {/* Check icon in a generous primary-green circle (decorative). */}
      <div
        aria-hidden
        className="flex h-24 w-24 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <Check className="h-12 w-12" />
      </div>

      {/* Headline — h2 (route owns h1). */}
      <h2 className="text-center text-title-1 font-semibold text-text-primary">
        {t("envelope_handover.headline")}
      </h2>

      {/* Body sentence — amount inline styled in amount-large + primary-green. */}
      <p className="text-center text-body-1 text-text-primary">
        {t("envelope_handover.body_amount_prefix")}{" "}
        <span
          className="text-amount-large font-bold text-primary"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatFcfaAmount(payoutAmount)} FCFA
        </span>{" "}
        {t("envelope_handover.body_recipient", { memberName })}
      </p>

      {/* Subtext slot — conditional; only this block has aria-live. */}
      {subtextEl}

      {/* Single CTA — mount-time focus target. Arrow wrap drops the
          synthetic MouseEvent so the prop signature stays `() => void`. */}
      <Button ref={ctaRef} className="w-full" onClick={() => onReturnToMembers()}>
        {t("envelope_handover.cta_return")}
      </Button>
    </section>
  );
}
