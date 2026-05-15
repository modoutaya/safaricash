// Story 8.5 / FR43 / NFR-P7 — stalled-sync detection.
//
// An offline event still pending in the local outbox longer than the
// NFR-P7 threshold (15 min) is "stalled": the connectivity pill escalates
// to the sync-failed state and the sync drawer offers a manual "Retenter".
//
// The 15-minute clock is anchored to ONE per-collector marker in
// localStorage (`safaricash:sync:stalled-since:{collectorId}`), so it
// survives an app reload and is NOT reset by going offline. The marker is
// written when the outbox first becomes non-empty and cleared on an
// observed drain (a >0 → 0 transition) or a collector switch. The
// IndexedDB event log itself stays immutable — Story 8.5 adds NO field to
// OfflineEvent (the eventLog.ts header mandates the log is append-only).
//
// All `stalled` state changes are dispatched from setTimeout callbacks
// (never synchronously in the effect body, never via Date.now() during
// render) so the react-hooks purity + set-state-in-effect rules hold.
//
// See: epics.md:1244-1251 (Story 8.5 BDD), prd.md FR43 + NFR-P7,
// ux-design-specification.md:990 (sync-failed pill).

import { useEffect, useRef, useState } from "react";

/** NFR-P7 — an event unsynced for this long after reconnection is
 *  surfaced as stalled (15 minutes). */
export const STALLED_THRESHOLD_MS = 15 * 60 * 1000;

/** Test-only seam: a Playwright E2E sets this localStorage key to a small
 *  value so the stalled flow can be exercised without waiting 15 real
 *  minutes. Never written by production code. */
const E2E_THRESHOLD_KEY = "safaricash:e2e:stalled-threshold-ms";

function markerKey(collectorId: string): string {
  return `safaricash:sync:stalled-since:${collectorId}`;
}

function resolveThresholdMs(): number {
  try {
    const raw = localStorage.getItem(E2E_THRESHOLD_KEY);
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10);
      // Strictly positive — a stray "0" override must not force an
      // instant permanent sync-failed state.
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    /* localStorage unavailable — fall through to the default */
  }
  return STALLED_THRESHOLD_MS;
}

function readMarker(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeMarker(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* localStorage unavailable / quota — degrade silently */
  }
}

function removeMarker(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* localStorage unavailable — nothing to clean up */
  }
}

export interface UseStalledSyncArgs {
  /** navigator.onLine — sync is never stalled while offline. */
  online: boolean;
  /** Length of the IndexedDB outbox for the current collector. */
  pendingCount: number;
  /** Current session collector id; null when signed out. */
  collectorId: string | null;
}

/**
 * Returns true when the outbox has been non-empty for longer than the
 * NFR-P7 threshold AND the device is online — i.e. reconnection happened
 * but the queue is not draining. Drives `useConnectivityState.hasFailed`.
 */
export function useStalledSync({ online, pendingCount, collectorId }: UseStalledSyncArgs): boolean {
  const [stalled, setStalled] = useState(false);
  // Tracks the previous collector so a sign-out / collector switch clears
  // the outgoing collector's marker.
  const prevCollectorRef = useRef<string | null>(null);
  // Tracks the previous outbox length so the marker is cleared ONLY on a
  // real >0 → 0 drain — never on the initial 0 (which means "count not
  // loaded yet", not "empty"; clearing then would reset the clock on
  // every app reload).
  const prevPendingRef = useRef<number | null>(null);

  useEffect(() => {
    const prevCollector = prevCollectorRef.current;
    prevCollectorRef.current = collectorId;
    if (prevCollector && prevCollector !== collectorId) {
      removeMarker(markerKey(prevCollector));
    }

    const prevPending = prevPendingRef.current;
    prevPendingRef.current = pendingCount;

    // Not tracking — no session, or the queue is empty.
    if (!collectorId || pendingCount === 0) {
      if (collectorId && pendingCount === 0 && prevPending !== null && prevPending > 0) {
        // Observed drain (>0 → 0) — clear the marker so the next backlog
        // starts a fresh 15-minute clock. An initial 0 (prevPending null)
        // is "count still loading" and must NOT clear a reload-durable
        // marker.
        removeMarker(markerKey(collectorId));
      }
      const sync = setTimeout(() => setStalled(false), 0);
      return () => clearTimeout(sync);
    }

    // Queue non-empty — ensure the marker exists (anchored at the first
    // observation, persisted across reloads, untouched by going offline).
    const key = markerKey(collectorId);
    let stalledSince = readMarker(key);
    if (stalledSince === null) {
      stalledSince = Date.now();
      writeMarker(key, stalledSince);
    }

    // Offline: never surface a stalled state (no network is expected, not
    // a failure — UX "offline-as-empowerment"). The marker stays.
    if (!online) {
      const sync = setTimeout(() => setStalled(false), 0);
      return () => clearTimeout(sync);
    }

    // Online + pending: stalled now if past threshold, else schedule the
    // flip. setState only ever runs inside these timer callbacks.
    const remainingMs = resolveThresholdMs() - (Date.now() - stalledSince);
    const stalledNow = remainingMs <= 0;
    const sync = setTimeout(() => setStalled(stalledNow), 0);
    const flip = stalledNow ? undefined : setTimeout(() => setStalled(true), remainingMs);
    return () => {
      clearTimeout(sync);
      if (flip !== undefined) clearTimeout(flip);
    };
  }, [online, pendingCount, collectorId]);

  return stalled;
}
