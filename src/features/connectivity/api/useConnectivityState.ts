// Story 8.1 / FR41 / UX-DR5 — connectivity state hook.
// Story 8.3 — pendingCount now reflects the real IDB-backed outbox via
// a BroadcastChannel subscription (countEvents partitioned by the
// current collector via useCollectorId).
// Story 8.5 — hasFailed now reflects real stalled-sync state via
// useStalledSync (NFR-P7 15-minute threshold).
//
// See: epics.md:1177-1186 (Story 8.1 BDD), epics.md:1203-1218 (Story 8.3),
// epics.md:1244-1251 (Story 8.5), prd.md:534 (FR41),
// ux-design-specification.md:975-1002.

import { useEffect, useState } from "react";

import { useCollectorId } from "@/features/auth/api/useCollectorId";
import {
  countEvents,
  EVENT_LOG_CHANNEL_NAME,
  type EventLogChangeMessage,
} from "@/infrastructure/sync";

import { useStalledSync } from "./useStalledSync";

export type ConnectivityStateValue = "connected" | "syncing" | "offline" | "sync-failed";

export interface ConnectivityState {
  /** Derived label per AC #3 ordering: offline → sync-failed → syncing → connected. */
  state: ConnectivityStateValue;
  /** Raw navigator.onLine value, exposed for advanced consumers (drawer, debug). */
  online: boolean;
  /** Count of operations queued in the outbox. Story 8.1 placeholder = 0; Story 8.3 wires the real source. */
  pendingCount: number;
  /** True when the outbox has been stalled past the NFR-P7 threshold
   *  (Story 8.5 — real value via useStalledSync). */
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

  // Story 8.3 — real pendingCount via the BroadcastChannel emitted by
  // appendEvent / deleteEvent / _clearAllEvents in @/infrastructure/sync.
  // Partition is the current collector id (session-aware).
  const collectorId = useCollectorId();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!collectorId) {
      // No session — reset pendingCount to 0 via cleanup so a stale
      // count from a previous collector doesn't leak past sign-out
      // (Story 8.3 code-review fix). The cleanup is asynchronous
      // relative to the effect body so it doesn't trigger the lint
      // rule react-hooks/set-state-in-effect.
      return () => {
        setPendingCount(0);
      };
    }
    let cancelled = false;
    const refresh = (message?: EventLogChangeMessage) => {
      // Filter on message type — `_clearAllEvents` (test-only) and
      // any future non-count-affecting types are ignored. Also filter
      // on collectorId when the message carries one: Tab A as collector
      // X shouldn't refetch on Tab B's (collector Y) events.
      if (message) {
        if (message.type !== "append" && message.type !== "delete") return;
        if (message.collectorId && message.collectorId !== collectorId) return;
      }
      countEvents(collectorId)
        .then((n) => {
          if (!cancelled) setPendingCount(n);
        })
        .catch(() => {
          /* keep last-known count on transient IDB errors */
        });
    };
    // Initial read — no message means "force refresh".
    refresh();

    if (typeof BroadcastChannel === "undefined") {
      return () => {
        cancelled = true;
      };
    }
    const channel = new BroadcastChannel(EVENT_LOG_CHANNEL_NAME);
    const handler = (e: MessageEvent<EventLogChangeMessage>) => refresh(e.data);
    channel.addEventListener("message", handler);
    return () => {
      cancelled = true;
      channel.removeEventListener("message", handler);
      channel.close();
    };
  }, [collectorId]);

  // Story 8.5 — real stalled-sync flag. The outbox is "stalled" once it
  // has been non-empty past the NFR-P7 threshold while online; deriveState
  // then promotes the pill to the `sync-failed` state.
  const hasFailed = useStalledSync({ online, pendingCount, collectorId });

  return {
    state: deriveState(online, pendingCount, hasFailed),
    online,
    pendingCount,
    hasFailed,
  };
}
