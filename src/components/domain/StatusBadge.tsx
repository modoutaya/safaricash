// Story 2.1 — shared status pill for member / cycle / dashboard surfaces.
//
// UX spec § Color-agnostic status rule (NFR-A4): every status badge combines
// color + text label. Color alone is forbidden. Tailwind tokens only — no
// hex literals (CLAUDE.md § Anti-patterns, ESLint no-restricted-syntax).
//
// Placed in components/domain/ (not features/member/ui/) because Epic 3
// cycle surfaces, Story 2.4 profile, and future dashboard stats all reuse
// it — cross-feature imports into features/member/ui/ would violate the
// layering rule (CLAUDE.md § Layering, ESLint import/no-internal-modules).

import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

// StatusBadge owns its own `kind` string-union so it doesn't depend on a
// feature. features/member re-exports `DisplayStatus = StatusBadgeKind`
// for convenience so callers don't need two imports.
export type StatusBadgeKind = "actif" | "avance" | "termine";

export interface StatusBadgeProps {
  kind: StatusBadgeKind;
  className?: string;
}

/** Tailwind class bundle per status. Mapped to semantic tokens from
 *  tailwind.config.ts; NOT hex literals (enforced by ESLint). */
const STATUS_CLASSES: Record<StatusBadgeKind, string> = {
  actif: "bg-primary-100 text-primary-700",
  avance: "bg-warning-bg text-warning-text",
  termine: "bg-info-bg text-info-text",
};

const STATUS_I18N_KEY: Record<
  StatusBadgeKind,
  "members.status_badge_actif" | "members.status_badge_avance" | "members.status_badge_termine"
> = {
  actif: "members.status_badge_actif",
  avance: "members.status_badge_avance",
  termine: "members.status_badge_termine",
};

export function StatusBadge({ kind, className }: StatusBadgeProps): JSX.Element {
  const t = useT();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-caption font-medium",
        STATUS_CLASSES[kind],
        className,
      )}
      // data-status for test selection + future analytics.
      data-status={kind}
    >
      {t(STATUS_I18N_KEY[kind])}
    </span>
  );
}
