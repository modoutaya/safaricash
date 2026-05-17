import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-body-1 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary-600 hover:shadow-cta-hover active:bg-primary-700",
        // Story 2.6 — destructive uses the deep-brown shade (token
        // destructive.text = #712B13) as the surface so white text passes
        // WCAG AA (4.5:1). The lighter destructive.DEFAULT (#E24B4A) stays
        // available for low-prominence accents (banners, icons).
        destructive:
          "bg-destructive-text text-white hover:bg-destructive-text/90 active:bg-destructive-text/80",
        // Amber CTA for the warning palette (token warning = #854F0B) —
        // dark enough that white text passes WCAG AA, mirroring the
        // destructive-variant rationale above.
        warning: "bg-warning text-white hover:bg-warning/90 active:bg-warning/80",
        outline: "border border-primary text-primary-700 bg-transparent hover:bg-primary-50",
        secondary: "bg-primary-50 text-primary-900 hover:bg-primary-100",
        ghost: "text-primary-700 hover:bg-primary-50",
        link: "text-primary-700 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-12 px-6 text-amount-inline",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
