// Story 10.3 / FR33b — collector-side dispute banner on the member profile.
//
// Mirrors CycleEndingAlert (the warning-banner pattern) but with the
// destructive palette and NO dismiss button — the banner stays until the
// disputes are resolved. Always mounted (sr-only when empty) so screen
// readers announce the count when it lands. NEVER mounted on the
// dashboard — disputes land privately on the member profile (FR33b).

import { useT } from "@/i18n/useT";
import { Button } from "@/components/ui/button";

export interface DisputeInlineBannerProps {
  /** Number of OPEN disputes on this member's transactions. */
  count: number;
  /** Opens the dispute detail view. */
  onViewDetail: () => void;
}

export function DisputeInlineBanner({
  count,
  onViewDetail,
}: DisputeInlineBannerProps): JSX.Element {
  const t = useT();
  const hasContent = count > 0;

  return (
    <section
      role="status"
      aria-live="polite"
      data-testid="dispute-banner"
      className={
        hasContent
          ? "flex items-center gap-3 rounded-md border border-destructive/20 bg-destructive-bg px-4 py-3 text-destructive-text"
          : "sr-only"
      }
    >
      {hasContent ? (
        <>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-body-1 font-semibold">{t("dispute.banner.title")}</p>
            <p className="text-body-2">
              {t(count === 1 ? "dispute.banner.body_one" : "dispute.banner.body_many", { count })}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onViewDetail}>
            {t("dispute.banner.cta")}
          </Button>
        </>
      ) : null}
    </section>
  );
}
