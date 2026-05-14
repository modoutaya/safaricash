// Story 8.1 / FR41 / UX-DR5 — connectivity state hook.
//
// Browser navigator.onLine detection + state-derivation. Returns the
// {state, online, pendingCount, hasFailed} contract that the
// ConnectivityIndicator pill + ConnectivitySyncDrawer consume. Story 8.3
// will plug in the real IndexedDB-backed pendingCount; Story 8.4 will
// plug in the reconciler's hasFailed flag. The hook contract is locked
// here so subsequent Epic 8 stories swap the placeholders without
// touching consumers.
//
// See: epics.md:1177-1186 (Story 8.1 BDD), prd.md:534 (FR41),
// ux-design-specification.md:975-1002 (full component spec § 1).

import { useEffect, useState } from "react";

export type ConnectivityStateValue = "connected" | "syncing" | "offline" | "sync-failed";

export interface ConnectivityState {
  /** Derived label per AC #3 ordering: offline → sync-failed → syncing → connected. */
  state: ConnectivityStateValue;
  /** Raw navigator.onLine value, exposed for advanced consumers (drawer, debug). */
  online: boolean;
  /** Count of operations queued in the outbox. Story 8.1 placeholder = 0; Story 8.3 wires the real source. */
  pendingCount: number;
  /** True when the reconciler's last sync attempt failed. Story 8.1 placeholder = false; Story 8.4 wires the real flag. */
  hasFailed: boolean;
}

/**
 * Exported for direct testing — covers the state-priority contract per
 * AC #3 (offline > sync-failed > syncing > connected) without depending
 * on the Story 8.3/8.4 placeholders being non-default in the hook.
 */
export function deriveState(
  online: boolean,
  pendingCount: number,
  hasFailed: boolean,
): ConnectivityStateValue {
  // Order matters (AC #3): offline first (don't pretend to sync without a
  // network), failed before syncing (signal the failure before auto-rolling
  // back to syncing), syncing before connected (if there's a backlog, we're
  // not idle).
  if (!online) return "offline";
  if (hasFailed) return "sync-failed";
  if (pendingCount > 0) return "syncing";
  return "connected";
}

function readInitialOnline(): boolean {
  // navigator.onLine returns true when offline detection is unavailable
  // (e.g., SSR, jsdom default). Defensive default to true matches that
  // expectation: an unknown environment is assumed connected.
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function useConnectivityState(): ConnectivityState {
  const [online, setOnline] = useState<boolean>(readInitialOnline);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Story 8.1 placeholders. Story 8.3 will replace `pendingCount` with a
  // subscription to the IndexedDB outbox count; Story 8.4 will replace
  // `hasFailed` with the reconciler's last-attempt status. The state
  // derivation logic (deriveState) is the canonical source of truth and
  // never moves — only its inputs change.
  const pendingCount = 0;
  const hasFailed = false;

  return {
    state: deriveState(online, pendingCount, hasFailed),
    online,
    pendingCount,
    hasFailed,
  };
}
