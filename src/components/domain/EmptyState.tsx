// Generic empty-state surface — Story 1.5 AC #9 + UX § Component 9.
//
// First use: post-login zero-members landing (Flow 5 step P). Story 2.1
// will reuse this for the real member list, and other features (cycles,
// transactions) may reuse it as they ship.
//
// Design:
//   - Large emoji at 64px, opacity 0.3 (UX spec — approachable, not a warning)
//   - h1 headline + body-1 subtext, centered, vertically roomy
//   - single primary CTA, full-width on mobile
//   - semantic <main>/<h1> hierarchy for a11y; axe-core enforces contrast +
//     heading order in the sibling test.

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

export type EmptyStateProps = {
  emoji: string;
  headline: string;
  subtext: string;
  ctaLabel: string;
  onCtaClick: () => void;
  /** Optional right-aligned decoration (e.g. a help link). */
  slotEnd?: ReactNode;
};

export function EmptyState({
  emoji,
  headline,
  subtext,
  ctaLabel,
  onCtaClick,
  slotEnd,
}: EmptyStateProps) {
  return (
    <section
      aria-label={headline}
      className="flex flex-col items-center justify-center gap-6 px-4 py-8 text-center"
    >
      <div aria-hidden="true" className="select-none text-[64px] leading-none opacity-30">
        {emoji}
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-title-1 text-text-primary">{headline}</h1>
        <p className="text-body-1 text-text-secondary">{subtext}</p>
      </div>
      <Button onClick={onCtaClick} className="w-full max-w-sm" size="lg">
        {ctaLabel}
      </Button>
      {slotEnd ? <div className="mt-2">{slotEnd}</div> : null}
    </section>
  );
}
