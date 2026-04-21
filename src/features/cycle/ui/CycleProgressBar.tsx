// Story 2.1 — cycle day-of-30 progress indicator reused across list / profile
// / settlement surfaces.
//
// Visual: hairline border + primary-500 fill (NOT gradient — gradient is
// reserved for hero surfaces per UX spec line 646). 4 px tall on mobile.
// a11y: role="progressbar" with aria-valuemin/max/now so screen readers
// announce "Day N of 30" naturally (NFR-A1).

import { cn } from "@/lib/utils";

export interface CycleProgressBarProps {
  /** 1-indexed cycle day per PRD FR19. Clamped to [0, totalDays]; the 0
   *  fallback is only for edge-cases where day hasn't started. */
  dayNumber: number;
  totalDays?: number;
  className?: string;
}

export function CycleProgressBar({
  dayNumber,
  totalDays = 30,
  className,
}: CycleProgressBarProps): JSX.Element {
  // Defensive clamping — callers compute dayNumber from date arithmetic
  // which can drift on DST / clock skew.
  let clamped = dayNumber;
  if (!Number.isFinite(dayNumber) || dayNumber < 0) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console -- dev-only bounds breach
      console.warn(`[CycleProgressBar] dayNumber out of range: ${dayNumber}; clamping to 0.`);
    }
    clamped = 0;
  } else if (dayNumber > totalDays) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console -- dev-only bounds breach
      console.warn(
        `[CycleProgressBar] dayNumber ${dayNumber} exceeds totalDays ${totalDays}; clamping.`,
      );
    }
    clamped = totalDays;
  }

  const percent = totalDays === 0 ? 0 : (clamped / totalDays) * 100;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={totalDays}
      aria-valuenow={clamped}
      aria-label={`Jour ${clamped} sur ${totalDays}`}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-primary-50", className)}
    >
      <div
        className="h-full rounded-full bg-primary-500 transition-[width] duration-200"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
