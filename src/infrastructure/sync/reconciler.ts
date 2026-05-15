// Story 8.4 / FR42 / NFR-P6 — IndexedDB outbox reconciler.
// Story 8.4 code-review patches applied — see Review Findings.
//
// Drains the offline event log to Supabase via the record-* RPCs in
// timestamp-ASC order. Serial loop (no Promise.all batching — order
// matters when future stories add member.* events that have causal
// dependencies). NFR-P6 budget: 150 events in p95 ≤ 90 s on typical
// WAEMU 3G → ~600ms / event including server round-trip + audit
// trigger latency. Serial at this scale is plenty fast.
//
// Single-in-flight via a module-scope promise: concurrent
// `replayPendingEvents()` calls for the SAME collector return the
// SAME in-flight promise so two tabs / two `online` events don't race
// a double drain. Calls for a DIFFERENT collector wait for the current
// drain to finish before starting (avoids cross-collector auth-mismatch
// where the in-flight drain's events belong to collector A but the new
// caller's session is collector B). Combined with the RPCs' server-
// side idempotency check (Story 8.4 migrations 0057-0059), a double-
// drain is safe even when the guard misses.
//
// Error classification:
//   - network / 5xx     → transient. Stop the drain. Caller (the hook)
//                         schedules a backoff retry. Queue stays intact.
//   - unauthorized      → permanent for the SESSION. Stop the drain (all
//                         subsequent events would fail the same). Counted
//                         as `sessionFailures` (NOT networkFailures) so
//                         Story 8.5's retry UI can distinguish.
//   - validation /      → permanent for THIS event. Skip + continue
//     not_found /         (events are independent). The poisoned event
//     unique_violation    stays in the IDB log without deleteEvent;
//     unsupported_kind    Story 8.5 will surface it for manual retry.
//
// Cache reconciliation is the caller's job (useReconciler hook calls
// queryClient.invalidateQueries on a clean drain). This module is pure
// infrastructure — no React, no QueryClient, no toasts.
//
// Limitation (acknowledged in code-review): listEvents is called once
// at the start of a drain. Events appended to IDB DURING the drain are
// invisible until the next trigger. Acceptable trade-off — Story 8.5
// reviews if collectors actually hit this in practice.

import { supabase } from "@/infrastructure/supabase/client";

import { deleteEvent, listEvents, OfflineEventLogError } from "./eventLog";
import type { OfflineEvent, OfflineEventType } from "./types";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface ReplayResult {
  /** Number of events the loop attempted (= initial queue length unless
   *  stopped early by a session/network error or stopReplay). */
  attempted: number;
  /** Successfully POSTed + deleted from IDB. */
  succeeded: number;
  /** Permanent failures (validation / not_found / unique_violation /
   *  unsupported_kind). Story 8.5 will surface these for manual retry. */
  skipped: number;
  /** Transient failures (network / 5xx / unknown / transient IDB error).
   *  Drain stopped on the first occurrence. */
  networkFailures: number;
  /** Session-expired (42501 / 28000). Drain stopped because all remaining
   *  events would fail the same way until the user re-authenticates.
   *  Story 8.5 will distinguish this from networkFailures in the retry UI. */
  sessionFailures: number;
  /** Total wall-clock time of the run. Soft observability for NFR-P6. */
  durationMs: number;
}

export type ReplayErrorCode =
  | "network"
  | "unauthorized"
  | "validation"
  | "not_found"
  | "unique_violation"
  | "transient_idb"
  | "unsupported_kind"
  | "unknown";

// ---------------------------------------------------------------------------
// Single-in-flight guard + stop signal (module-scope)
// ---------------------------------------------------------------------------

let inFlight: Promise<ReplayResult> | undefined;
let inFlightCollectorId: string | undefined;
let stopRequested = false;

/**
 * Drain pending events for the given collector. Single-in-flight per
 * module load for the SAME collector. If a drain is in flight for a
 * DIFFERENT collector, await it before starting (avoids the cross-
 * collector auth-mismatch race where the in-flight drain's events
 * belong to collector A but the new caller's session is collector B).
 *
 * @throws never — all failures are captured into `ReplayResult`.
 */
export function replayPendingEvents(collectorId: string): Promise<ReplayResult> {
  // Same-collector + in-flight → share the existing promise.
  if (inFlight && inFlightCollectorId === collectorId) return inFlight;
  // Different-collector + in-flight → queue behind it.
  if (inFlight) {
    return inFlight.then(() => replayPendingEvents(collectorId));
  }
  stopRequested = false;
  inFlightCollectorId = collectorId;
  inFlight = drainInternal(collectorId).finally(() => {
    inFlight = undefined;
    inFlightCollectorId = undefined;
  });
  return inFlight;
}

/** Signal the current drain to stop after the current event finishes.
 *  Resolves when the loop exits (or immediately if no drain is in
 *  flight). Always resets `stopRequested` so a later drain isn't
 *  permanently gated by a stale signal from a previous call. */
export async function stopReplay(): Promise<void> {
  if (!inFlight) {
    // No drain to stop — but reset the flag in case a prior stopReplay
    // call set it during a window where inFlight was undefined.
    stopRequested = false;
    return;
  }
  stopRequested = true;
  try {
    await inFlight;
  } catch {
    /* swallow — the caller just wants to know the drain has stopped */
  }
}

// ---------------------------------------------------------------------------
// Error classifier (exported for tests + future callers)
// ---------------------------------------------------------------------------

export function classifyReplayError(err: unknown): ReplayErrorCode {
  if (err instanceof TypeError) return "network";
  if (err instanceof OfflineEventLogError) return "transient_idb";

  // Explicit object guard before the cast — primitive throws (strings,
  // numbers, false) collapse to "unknown" instead of accidentally
  // hitting the message-substring branches via .toLowerCase() on undefined.
  if (err == null || typeof err !== "object") return "unknown";

  const candidate = err as { code?: string; message?: string; status?: number };
  const code = candidate.code;
  const status = candidate.status;
  const msg = (candidate.message ?? "").toLowerCase();

  if (status !== undefined && status >= 500) return "network";
  if (msg.includes("fetch") || msg.includes("networkerror")) return "network";

  if (code === "42501" || code === "28000") return "unauthorized";
  if (msg.includes("auth_required") || msg.includes("unauthorized")) return "unauthorized";

  if (code === "P0002" || code === "PGRST116") return "not_found";
  if (msg.includes("not_found")) return "not_found";

  // 23505 (unique_violation) — concurrent same-collector replay hit the
  // partial UNIQUE index on (collector_id, event_id) racing the RPC's
  // SELECT-then-INSERT. The other transaction already committed; this
  // one is redundant. Skip + continue: the next drain attempt's RPC
  // early-return will return the existing tx id and deleteEvent will
  // clear the local entry.
  if (code === "23505") return "unique_violation";

  if (code === "23514" || code === "22023" || code === "22000") return "validation";
  if (msg.includes("cycle_closed") || msg.includes("invalid_") || msg.includes("over_limit")) {
    return "validation";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Internal drain loop
// ---------------------------------------------------------------------------

async function drainInternal(collectorId: string): Promise<ReplayResult> {
  const startMs = Date.now();
  const events = await listEvents(collectorId);
  const result: ReplayResult = {
    attempted: 0,
    succeeded: 0,
    skipped: 0,
    networkFailures: 0,
    sessionFailures: 0,
    durationMs: 0,
  };

  for (const event of events) {
    if (stopRequested) break;
    result.attempted += 1;

    const rpcName = resolveRpcName(event.eventType);
    if (!rpcName) {
      console.warn(
        "[reconciler] unsupported_kind — skipping event",
        event.eventType,
        event.eventId,
      );
      result.skipped += 1;
      continue;
    }

    let rpcSucceeded = false;
    try {
      // The event's payload is already shaped as `{p_*: …}` snake_case
      // (Story 8.3's buildOfflineEvent built it that way). Direct spread.
      const { error } = await supabase.rpc(
        rpcName as Parameters<typeof supabase.rpc>[0],
        event.payload as Parameters<typeof supabase.rpc>[1],
      );
      if (error) throw error;
      rpcSucceeded = true;
    } catch (err) {
      const code = classifyReplayError(err);
      if (code === "network" || code === "unknown" || code === "transient_idb") {
        result.networkFailures += 1;
        break;
      }
      if (code === "unauthorized") {
        result.sessionFailures += 1;
        break;
      }
      // validation / not_found / unique_violation / unsupported_kind
      // → permanent (or self-healing) for THIS event; skip + continue.
      // unique_violation: another tab already committed this event_id —
      // next drain will hit the RPC's idempotent early-return and clear.
      result.skipped += 1;
      continue;
    }

    if (rpcSucceeded) {
      try {
        await deleteEvent(event.eventId, collectorId);
        result.succeeded += 1;
      } catch (err) {
        // The RPC committed server-side but IDB delete failed (quota,
        // transient IO). The event will be replayed next drain; the
        // RPC's idempotent early-return makes that safe. Treat as a
        // transient failure so the drain stops (signals the hook to
        // schedule a backoff retry).
        if (err instanceof OfflineEventLogError) {
          console.warn(
            "[reconciler] deleteEvent failed after RPC success — will retry on next drain",
            event.eventId,
            err.code,
          );
          result.networkFailures += 1;
          break;
        }
        throw err;
      }
    }
  }

  result.durationMs = Date.now() - startMs;
  return result;
}

function resolveRpcName(eventType: OfflineEventType): string | null {
  switch (eventType) {
    case "transaction.contribution_recorded":
      return "record_contribution";
    case "transaction.advance_recorded":
      return "record_advance";
    case "transaction.rattrapage_recorded":
      return "record_rattrapage";
    // Story 8.6 — offline member edits replay through update_member.
    case "member.updated":
      return "update_member";
    // Future stories own these:
    case "transaction.undone":
    case "member.created":
    case "member.deleted":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Test-only reset
// ---------------------------------------------------------------------------

/** Test-only — awaits any orphaned in-flight drain before resetting
 *  module state. Without the await, a slow drain from a prior test
 *  could mutate `stopRequested` after the next test's `replayPendingEvents`
 *  starts, causing intermittent failures. */
export async function _resetReconcilerForTests(): Promise<void> {
  const pending = inFlight;
  if (pending) {
    try {
      await pending;
    } catch {
      /* swallow */
    }
  }
  inFlight = undefined;
  inFlightCollectorId = undefined;
  stopRequested = false;
}

// Suppress unused-imports linter while keeping the type available
// for future consumers who need to import OfflineEvent alongside the
// reconciler in their own modules.
export type { OfflineEvent };
