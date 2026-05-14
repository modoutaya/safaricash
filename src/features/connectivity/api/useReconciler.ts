// Story 8.4 / FR42 — useReconciler hook.
// Story 8.4 code-review patches applied — see Review Findings.
//
// Trigger surface for the offline reconciler. Subscribes to:
//   1. Mount (boot-replay — catches events queued in a previous session).
//   2. `window.online` event (re-trigger on connectivity return).
//   3. Exponential backoff timer (re-trigger after a failed drain — covers
//      the case where the device stays online but the server errors,
//      where no further `online` event would fire on its own).
//
// On a clean drain (succeeded > 0 && no failures of any kind), invalidates
// MEMBERS_QUERY_KEY + MEMBER_PROFILE_QUERY_KEY so the cache swaps Story
// 8.3's optimistic snapshots for server truth.
//
// The hook is mounted in AppLayout (next to ConnectivityIndicator) inside
// the authenticated layout. Side-effect-only — no return value.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCollectorId } from "@/features/auth/api/useCollectorId";
import { MEMBERS_QUERY_KEY, MEMBER_PROFILE_QUERY_KEY } from "@/features/member";
import { computeBackoffMs, replayPendingEvents, type ReplayResult } from "@/infrastructure/sync";

export function useReconciler(): void {
  const queryClient = useQueryClient();
  const collectorId = useCollectorId();
  // Prevent double-fire from React 18 Strict Mode (effect runs twice on
  // mount in dev). The reconciler module is single-in-flight, so the
  // second call is a no-op, but the ref keeps the effect side-effect
  // explicit. Reset at the top of every effect run so a collectorId
  // change (sign-out → sign-in as different user) re-arms the boot replay.
  const triggeredRef = useRef(false);
  const backoffTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attemptRef = useRef(0);

  useEffect(() => {
    // Reset on every effect run — covers React 18 Strict Mode + collector
    // change (sign-out → sign-in as a different user).
    triggeredRef.current = false;

    if (!collectorId) {
      // No session — nothing to reconcile.
      return;
    }

    const clearBackoffTimer = (): void => {
      if (backoffTimerRef.current !== undefined) {
        clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = undefined;
      }
    };

    const handleResult = (result: ReplayResult): void => {
      if (result.succeeded > 0 && result.networkFailures === 0 && result.sessionFailures === 0) {
        // Clean drain — reset backoff and invalidate caches. The
        // `skipped > 0` case (poisoned events) does NOT block
        // invalidation: the succeeded events are valid server-truth
        // and Story 8.5 will surface the skipped ones separately.
        attemptRef.current = 0;
        clearBackoffTimer();
        void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: MEMBER_PROFILE_QUERY_KEY });
        return;
      }
      // Transient failure (network / session) — schedule a backoff retry.
      // `online` event always cancels the timer to retry immediately.
      if (result.networkFailures > 0 || result.sessionFailures > 0) {
        clearBackoffTimer();
        const delayMs = computeBackoffMs(attemptRef.current);
        attemptRef.current += 1;
        backoffTimerRef.current = setTimeout(trigger, delayMs);
      }
    };

    const trigger = (): void => {
      clearBackoffTimer();
      replayPendingEvents(collectorId)
        .then(handleResult)
        .catch((err: unknown) => {
          // Story 8.4 code-review patch — listEvents can throw
          // OfflineEventLogError (DB_OPEN_FAILED on Safari private
          // mode, storage eviction). The reconciler's JSDoc says
          // @throws never but the listEvents call inside drainInternal
          // is not caught. Surface to console for diagnostics; Story
          // 8.5 will route to toast.
          console.warn("[reconciler] replay rejected", err);
          // Treat as transient — schedule backoff retry so we don't
          // get stuck on a recoverable IDB error.
          clearBackoffTimer();
          const delayMs = computeBackoffMs(attemptRef.current);
          attemptRef.current += 1;
          backoffTimerRef.current = setTimeout(trigger, delayMs);
        });
    };

    // Boot-time replay (catches events from a prior session).
    if (!triggeredRef.current) {
      triggeredRef.current = true;
      trigger();
    }

    // `online` event always cancels the backoff timer + retries
    // immediately (the network coming back is a strong signal).
    const onlineHandler = (): void => {
      attemptRef.current = 0;
      trigger();
    };
    window.addEventListener("online", onlineHandler);

    return () => {
      window.removeEventListener("online", onlineHandler);
      clearBackoffTimer();
    };
  }, [collectorId, queryClient]);
}
