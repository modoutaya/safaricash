// Story 2.4 → 2.5 — extracted shells for the member profile + edit routes.
// Both routes share the same loading / error / not-found surface so the
// transition between viewing and editing feels seamless.

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface ProfileShellProps {
  message: string;
  backLabel: string;
  onBack: () => void;
  tone?: "neutral" | "destructive";
}

function ProfileShell({ message, backLabel, onBack, tone = "neutral" }: ProfileShellProps) {
  const messageClass = tone === "destructive" ? "text-destructive" : "text-text-secondary";
  return (
    <section
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-4"
      role="alert"
      aria-live="polite"
    >
      <p className={`text-body-1 ${messageClass}`}>{message}</p>
      <Button type="button" variant="outline" size="lg" onClick={onBack} className="w-full">
        {backLabel}
      </Button>
    </section>
  );
}

export function ProfileNotFound(props: Omit<ProfileShellProps, "tone">): ReactNode {
  return <ProfileShell {...props} tone="neutral" />;
}

export function ProfileError(props: Omit<ProfileShellProps, "tone">): ReactNode {
  return <ProfileShell {...props} tone="destructive" />;
}

export function ProfileSkeleton({ ariaLabel }: { ariaLabel: string }): ReactNode {
  return (
    <div
      aria-busy="true"
      aria-label={ariaLabel}
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-4"
    >
      <div className="h-32 animate-pulse rounded-lg bg-neutral-100" />
      <div className="h-12 animate-pulse rounded-lg bg-neutral-100" />
      <div className="h-12 animate-pulse rounded-lg bg-neutral-100" />
      <div className="h-12 animate-pulse rounded-lg bg-neutral-100" />
    </div>
  );
}
