// Story 3.5 / FR20 — dashboard cycles-ending alert.
//
// Banner using the warning palette (UX spec line 509). Reads the
// derivation hook directly — no props at MVP. Renders an empty live
// region when there's nothing to announce (count=0, dismissed, or
// loading); the section element stays mounted so screen readers that
// only announce mutations inside an already-mounted live region (NVDA
// / JAWS on Chrome) still pick up the count when it lands.
//
// See: epics.md:773-786 (Story 3.5 BDD), prd.md:500 (FR20),
// ux-design-specification.md:509 (warning palette).

import { X } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";

import { useCyclesEndingAlert } from "../api/useCyclesEndingAlert";

function bodyKey(
  count: number,
): "dashboard.cycles_ending.body_one" | "dashboard.cycles_ending.body_many" {
  return count === 1 ? "dashboard.cycles_ending.body_one" : "dashboard.cycles_ending.body_many";
}

export function CycleEndingAlert(): JSX.Element {
  const t = useT();
  const { count, isDismissed, dismiss, isLoading } = useCyclesEndingAlert();

  const hasContent = !isLoading && !isDismissed && count > 0;

  return (
    <section
      role="status"
      aria-live="polite"
      data-testid="cycle-ending-alert"
      className={
        hasContent
          ? "flex items-center gap-3 rounded-md border border-warning-200 bg-warning-50 px-4 py-3 text-warning-800"
          : "sr-only"
      }
    >
      {hasContent ? (
        <>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-body-1 font-semibold">{t("dashboard.cycles_ending.title")}</p>
            <p className="text-body-2">{t(bodyKey(count), { count })}</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to="/members?filter=cycles-ending">{t("dashboard.cycles_ending.cta")}</Link>
          </Button>
          <button
            type="button"
            aria-label={t("dashboard.cycles_ending.dismiss_aria")}
            onClick={dismiss}
            className="flex h-11 w-11 items-center justify-center rounded-md text-warning-800 hover:bg-warning-bg/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X size={18} aria-hidden />
          </button>
        </>
      ) : null}
    </section>
  );
}
