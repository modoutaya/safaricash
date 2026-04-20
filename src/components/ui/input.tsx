// shadcn/ui "input" re-skinned for SafariCash — Story 1.5.
//
// Generated default used oklch() CSS values — replaced with our Tailwind
// tokens (hairline border, surface-1 background, primary-green focus ring)
// per CLAUDE.md "Tokens, not hex" rule. Height bumped to 44px to meet
// NFR-A2 (44x44 minimum touch target).

import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 w-full rounded-md border border-hairline bg-surface-1 px-3 py-2 text-body-1 text-text-primary placeholder:text-text-tertiary",
          "focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
