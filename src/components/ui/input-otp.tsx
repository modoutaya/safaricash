// shadcn/ui "input-otp" re-skinned for SafariCash — Story 1.5 AC #6.
//
// Changes from the generated default:
//   - 56×56 px segments (NFR-A2 generous touch target) instead of 40×40.
//   - primary-green focus ring (`ring-primary-500`) instead of oklch(...)
//     CSS variables the shadcn CLI emits (CLAUDE.md: tokens not hex, and
//     the CLI's oklch() values are neither — they would bypass our token
//     contract entirely).
//   - hairline border (matches Card) instead of oklch borders.
//   - plain Tailwind classes only; no @apply, no custom CSS vars.
//   - caret color via `bg-text-primary` rather than oklch.
//
// The underlying `input-otp` library handles keyboard nav, paste, and auto-
// advance; we only style the container + slots.

import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";

import { cn } from "@/lib/utils";

const InputOTP = React.forwardRef<
  React.ElementRef<typeof OTPInput>,
  React.ComponentPropsWithoutRef<typeof OTPInput>
>(({ className, containerClassName, ...props }, ref) => (
  <OTPInput
    ref={ref}
    containerClassName={cn(
      "flex items-center gap-2 has-[:disabled]:opacity-50",
      containerClassName,
    )}
    className={cn("disabled:cursor-not-allowed", className)}
    {...props}
  />
));
InputOTP.displayName = "InputOTP";

const InputOTPGroup = React.forwardRef<
  React.ElementRef<"div">,
  React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex items-center gap-2", className)} {...props} />
));
InputOTPGroup.displayName = "InputOTPGroup";

const InputOTPSlot = React.forwardRef<
  React.ElementRef<"div">,
  React.ComponentPropsWithoutRef<"div"> & { index: number }
>(({ index, className, ...props }, ref) => {
  const inputOTPContext = React.useContext(OTPInputContext);
  const slot = inputOTPContext.slots[index];
  if (!slot) return null;
  const { char, hasFakeCaret, isActive } = slot;

  return (
    <div
      ref={ref}
      aria-label={`Chiffre ${index + 1} du code`}
      className={cn(
        // 56x56 per NFR-A2; rounded-md (12px); hairline border; white surface.
        "relative flex h-14 w-14 items-center justify-center rounded-md border border-hairline bg-surface-1 text-title-1 font-semibold text-text-primary transition-all",
        // Active = focused slot — primary-green ring, matches button focus.
        isActive &&
          "z-10 border-primary ring-2 ring-primary-500 ring-offset-2 ring-offset-surface-1",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-px animate-pulse bg-text-primary duration-1000" />
        </div>
      )}
    </div>
  );
});
InputOTPSlot.displayName = "InputOTPSlot";

export { InputOTP, InputOTPGroup, InputOTPSlot };
