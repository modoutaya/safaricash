// Story 8.1 / FR41 / UX-DR5 — persistent connectivity pill.
//
// 4 states (connected / syncing / offline / sync-failed) rendered as a
// header pill (24px tall, ARIA live-region for state-transition
// announcements). Pure presentation: props-driven so the parent
// (AppLayout) controls the drawer open state. Mirrors Story 7.1's
// SettlementSummaryCard discipline (zero internal state).
//
// UX-DR5: NEVER red-alarm. sync-failed uses amber + subtle pulse on
// the icon only — informational, not punitive.
//
// See: ux-design-specification.md:975-1002 (full component spec § 1),
// epics.md:1183 ("uses semantic colours, never red-alarm").

import { AlertTriangle, Loader2, Wifi, WifiOff } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import type { ConnectivityStateValue } from "../api/useConnectivityState";

export interface ConnectivityIndicatorProps {
  /** Derived state from useConnectivityState — drives icon + label + colour. */
  state: ConnectivityStateValue;
  /** Number rendered after the bullet for non-connected states. Hidden when 0 (UX line 1000). */
  pendingCount: number;
  /** Tap handler — typically opens the sync-status drawer. */
  onTap: () => void;
  className?: string;
}

type StateDescriptor = {
  /** Tailwind classes for the visible pill. */
  pillClass: string;
  /** Lucide icon component. */
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Whether the icon (not the pill) pulses — sync-failed only. */
  pulseIcon: boolean;
};

const STATE_DESCRIPTORS: Record<ConnectivityStateValue, StateDescriptor> = {
  connected: {
    pillClass: "bg-primary-100 text-primary-700",
    Icon: Wifi,
    pulseIcon: false,
  },
  syncing: {
    pillClass: "bg-warning-bg text-warning",
    // Loader2 already self-spins via animate-spin in JSX below — pulseIcon stays false.
    Icon: Loader2,
    pulseIcon: false,
  },
  offline: {
    pillClass: "bg-neutral-100 text-text-secondary",
    Icon: WifiOff,
    pulseIcon: false,
  },
  "sync-failed": {
    pillClass: "bg-warning-bg text-warning",
    Icon: AlertTriangle,
    pulseIcon: true,
  },
};

function labelKey(state: ConnectivityStateValue): string {
  switch (state) {
    case "connected":
      return "connectivity.state.connected";
    case "syncing":
      return "connectivity.state.syncing";
    case "offline":
      return "connectivity.state.offline";
    case "sync-failed":
      return "connectivity.state.sync_failed";
  }
}

export function ConnectivityIndicator({
  state,
  pendingCount,
  onTap,
  className,
}: ConnectivityIndicatorProps): JSX.Element {
  const t = useT();
  const descriptor = STATE_DESCRIPTORS[state];
  const { Icon, pillClass, pulseIcon } = descriptor;

  // UX line 1000: `{count}` hidden when zero. For non-connected states
  // with zero pending ops we still render the state name (e.g.
  // "Hors-ligne") — just without the trailing bullet+count suffix.
  // Code-review patch #2 — routed through i18n keys (`*_idle` variants)
  // instead of hardcoded French to honour the i18n contract (NFR-L2 —
  // Story 1.5 Wolof/Bambara translation surface).
  const renderedLabel = (() => {
    if (state === "connected") return t("connectivity.state.connected");
    if (pendingCount === 0) {
      // Bare form via dedicated i18n keys.
      switch (state) {
        case "offline":
          return t("connectivity.state.offline_idle");
        case "syncing":
          return t("connectivity.state.syncing_idle");
        case "sync-failed":
          return t("connectivity.state.sync_failed_idle");
      }
    }
    return t(labelKey(state) as Parameters<typeof t>[0], { count: pendingCount });
  })();

  const ariaLabel = t("connectivity.aria_label", { label: renderedLabel });

  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={ariaLabel}
      className={cn(
        // The visible pill is 24px tall; the button extends to py-2 so the
        // tap target reaches the 40px-ish UX minimum (AC #13).
        "inline-flex items-center justify-center py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500",
        className,
      )}
    >
      <span
        aria-live="polite"
        className={cn(
          "inline-flex h-6 items-center gap-1.5 rounded-full px-3 text-body-2 font-medium",
          pillClass,
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0",
            state === "syncing" ? "animate-spin" : null,
            pulseIcon ? "animate-pulse" : null,
          )}
        />
        <span>{renderedLabel}</span>
      </span>
    </button>
  );
}
