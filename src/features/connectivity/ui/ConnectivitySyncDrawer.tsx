// Story 8.1 — sync-status drawer skeleton (title + close + placeholder).
// Story 8.5 — drawer body: the pending-operations list (by member), a
//   stalled banner (shown only in the `sync-failed` state), and a manual
//   "Retenter" CTA that re-invokes the Story 8.4 reconciler with the
//   current (fresh) auth session.
//
// Native <dialog> shell opened by the ConnectivityIndicator. Mirrors the
// Story 6.6 ResendHistoryDialog / 7.4 SettlementReauthDialog pattern:
// useRef<HTMLDialogElement> + useEffect for showModal/close, programmatic
// focus on the close button at mount (jsx-a11y/no-autofocus enforced).
//
// See: epics.md:1244-1251 (Story 8.5 BDD), ux-design-specification.md:990,
// :1002 ("drawer listing pending operations by member with retry
// affordances"), :475 ("never a red alarm").

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useCollectorId } from "@/features/auth/api/useCollectorId";
import { MEMBERS_QUERY_KEY, type MemberWithMeta } from "@/features/member";
import {
  listEvents,
  replayPendingEvents,
  type OfflineEvent,
  type OfflineEventType,
  type ReplayResult,
} from "@/infrastructure/sync";
import { useT } from "@/i18n/useT";

import type { ConnectivityStateValue } from "../api/useConnectivityState";

export interface ConnectivitySyncDrawerProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  pendingCount: number;
  /** Story 8.5 — drives the stalled banner (rendered only in `sync-failed`)
   *  and the calm "synchronisation en cours" hint (in `syncing`). */
  state: ConnectivityStateValue;
}

function kindKey(type: OfflineEventType): string {
  switch (type) {
    case "transaction.contribution_recorded":
      return "connectivity.drawer.row_kind_contribution";
    case "transaction.advance_recorded":
      return "connectivity.drawer.row_kind_advance";
    case "transaction.rattrapage_recorded":
      return "connectivity.drawer.row_kind_rattrapage";
    default:
      return "connectivity.drawer.row_kind_other";
  }
}

/** The affected member id — transaction events carry `p_member_id` in the
 *  RPC payload (Story 8.3 buildOfflineEvent); fall back to `entityId`. */
function memberIdOf(event: OfflineEvent): string {
  const fromPayload = event.payload["p_member_id"];
  return typeof fromPayload === "string" ? fromPayload : event.entityId;
}

export function ConnectivitySyncDrawer({
  open,
  onOpenChange,
  pendingCount,
  state,
}: ConnectivitySyncDrawerProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const t = useT();
  const collectorId = useCollectorId();
  const queryClient = useQueryClient();

  const [events, setEvents] = useState<OfflineEvent[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<ReplayResult | null>(null);
  // Wall-clock time the list was last loaded — captured off-render (in the
  // listEvents callback) so relative-time labels stay react-hooks-pure.
  const [loadedAt, setLoadedAt] = useState(0);

  // showModal / close shim — same pattern as Story 6.6 / 7.4 dialogs.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  // Mount-time programmatic focus on the close button (UX-DR5 + Story 7.2
  // pattern; jsx-a11y/no-autofocus rule forbids the HTML autoFocus attr).
  useEffect(() => {
    if (open) {
      closeBtnRef.current?.focus();
    }
  }, [open]);

  // Reset per-session state when the drawer closes so a stale retry hint
  // / event list never leaks into the next open. setState is dispatched
  // from a setTimeout callback (the drawer renders nothing while closed,
  // so the reset is invisible) — keeps set-state-in-effect happy.
  useEffect(() => {
    if (open) return;
    const reset = setTimeout(() => {
      setRetryResult(null);
      setEvents([]);
      setLoadedAt(0);
    }, 0);
    return () => clearTimeout(reset);
  }, [open]);

  // Load the pending operations whenever the drawer is open. Re-runs when
  // `pendingCount` changes so a drain (manual retry OR the background
  // reconciler) refreshes the list.
  useEffect(() => {
    if (!open || !collectorId) return;
    let cancelled = false;
    listEvents(collectorId)
      .then((loaded) => {
        if (cancelled) return;
        setEvents(loaded);
        setLoadedAt(Date.now());
      })
      .catch(() => {
        /* IDB read failure — keep the last-known list, retry stays available */
      });
    return () => {
      cancelled = true;
    };
  }, [open, collectorId, pendingCount]);

  const handleRetry = async (): Promise<void> => {
    if (!collectorId || retrying) return;
    setRetrying(true);
    try {
      const result = await replayPendingEvents(collectorId);
      setRetryResult(result);
      const refreshed = await listEvents(collectorId);
      setEvents(refreshed);
      setLoadedAt(Date.now());
    } catch {
      /* replayPendingEvents never throws; listEvents may — handled by the
         next BroadcastChannel-driven pendingCount refresh */
    } finally {
      setRetrying(false);
    }
  };

  const members = queryClient.getQueryData<MemberWithMeta[]>(MEMBERS_QUERY_KEY) ?? [];
  const memberName = (event: OfflineEvent): string => {
    const id = memberIdOf(event);
    return members.find((m) => m.id === id)?.name ?? t("connectivity.drawer.member_fallback");
  };

  const recordedLabel = (event: OfflineEvent): string => {
    // Before the first listEvents resolves (loadedAt === 0) the elapsed
    // calc is meaningless — show the neutral "just now" copy rather than a
    // clamped-to-zero false age.
    if (loadedAt === 0) return t("connectivity.drawer.row_recorded_just_now");
    const minutes = Math.max(
      0,
      Math.floor((loadedAt - new Date(event.timestamp).getTime()) / 60000),
    );
    if (minutes < 1) return t("connectivity.drawer.row_recorded_just_now");
    if (minutes < 60) return t("connectivity.drawer.row_recorded_minutes", { minutes });
    return t("connectivity.drawer.row_recorded_hours", { hours: Math.floor(minutes / 60) });
  };

  const sessionExpired = retryResult !== null && retryResult.sessionFailures > 0;
  // Success copy only when the drain FULLY cleared the queue — a partial
  // drain (some succeeded, some network/skip failures remain) must not
  // claim success.
  const retrySucceeded =
    retryResult !== null &&
    retryResult.succeeded > 0 &&
    retryResult.networkFailures === 0 &&
    retryResult.skipped === 0 &&
    !sessionExpired;
  // Empty state: the queue is genuinely empty (count 0) OR the loaded list
  // is empty after a drain. `loadedAt > 0` distinguishes "loaded empty"
  // from "not loaded yet" so the initial open doesn't flash empty-state.
  const showEmpty = pendingCount === 0 || (loadedAt > 0 && events.length === 0);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onOpenChange(false)}
      aria-labelledby="connectivity-drawer-title"
      className="m-auto w-[90%] max-w-md rounded-lg border border-neutral-200 bg-background p-0 shadow-xl backdrop:bg-neutral-900/50"
    >
      {open ? (
        <div className="flex flex-col gap-4 p-6">
          <header className="flex items-center justify-between gap-3">
            <h2 id="connectivity-drawer-title" className="text-headline-2 text-text-primary">
              {t("connectivity.drawer.title")}
            </h2>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t("connectivity.drawer.close_label")}
              className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            >
              <X size={20} aria-hidden />
            </button>
          </header>

          {showEmpty ? (
            <p className="text-body-2 text-text-secondary">{t("connectivity.drawer.empty")}</p>
          ) : (
            <>
              {state === "sync-failed" ? (
                // role=status (not alert) — informational escalation, never
                // an interruptive red alarm (ux-design-specification.md:475).
                <p
                  role="status"
                  aria-live="polite"
                  className="flex items-start gap-2 rounded-md bg-warning-bg p-3 text-body-2 text-warning"
                >
                  <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
                  <span>{t("connectivity.drawer.stalled_banner")}</span>
                </p>
              ) : null}

              {state === "syncing" ? (
                <p className="text-body-2 text-text-secondary">
                  {t("connectivity.drawer.syncing_hint")}
                </p>
              ) : null}

              <ul
                aria-label={t("connectivity.drawer.list_label")}
                className="flex flex-col divide-y divide-hairline"
              >
                {events.map((event) => (
                  <li key={event.eventId} className="flex flex-col gap-0.5 py-2">
                    <span className="break-words text-body-2 font-medium text-text-primary">
                      {t(kindKey(event.eventType) as Parameters<typeof t>[0])} — {memberName(event)}
                    </span>
                    <span className="text-caption text-text-secondary">{recordedLabel(event)}</span>
                  </li>
                ))}
              </ul>

              {sessionExpired ? (
                <p role="status" aria-live="polite" className="text-body-2 text-warning">
                  {t("connectivity.drawer.session_expired_hint")}
                </p>
              ) : retrySucceeded ? (
                <p role="status" aria-live="polite" className="text-body-2 text-primary-700">
                  {t("connectivity.drawer.retry_success")}
                </p>
              ) : null}

              <Button
                type="button"
                size="lg"
                className="w-full"
                onClick={() => void handleRetry()}
                disabled={retrying}
                aria-disabled={retrying}
              >
                {retrying ? (
                  <>
                    <Loader2
                      aria-hidden
                      className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
                    />
                    {t("connectivity.drawer.retry_in_progress")}
                  </>
                ) : (
                  t("connectivity.drawer.retry_cta")
                )}
              </Button>
            </>
          )}

          <div className="flex flex-col gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => onOpenChange(false)}
            >
              {t("connectivity.drawer.close_label")}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
