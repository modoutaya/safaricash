// Story 8.3 / FR40 / AR8 — OfflineEvent builder for the 3 transaction
// mutations.
//
// Builds a Story-8.2 OfflineEvent from a mutation input + the freshly
// generated synthetic transaction ID. The payload is serialised in the
// SAME snake_case shape the RPCs expect (so Story 8.4's reconciler can
// blindly pass it through). Timestamp is canonicalised via the audit
// helper so it byte-matches what the trigger emits when the reconciler
// pushes the event.

import { toCanonicalTimestamp } from "@/domain/audit/hashChain";
import type { OfflineEvent } from "@/infrastructure/sync";

import type { RecordContributionInput } from "./useRecordContribution";
import type { RecordRattrapageInput } from "./useRecordRattrapage";
import type { RecordAdvanceInput } from "./RecordAdvanceInputSchema";

export type OfflineMutationInput =
  | { kind: "contribution"; input: RecordContributionInput }
  | { kind: "rattrapage"; input: RecordRattrapageInput }
  | { kind: "advance"; input: RecordAdvanceInput };

export interface BuildOfflineEventArgs {
  /** Pre-generated synthetic transaction ID (UUID v4 — `crypto.randomUUID()`).
   *  Used as both the IDB `eventId` AND the `entityId` so Story 8.4's
   *  reconciler can pass it as `p_event_id` for server-side idempotent
   *  dedup, and the optimistic-UI transaction row uses the same ID. */
  syntheticTxId: string;
  /** auth.uid() of the writing collector — from `useCollectorId` /
   *  `supabase.auth.getSession()`. NEVER `null` (the caller must short-
   *  circuit with an `unauthorized` error before reaching this helper). */
  collectorId: string;
  /** Discriminated mutation input. */
  mutation: OfflineMutationInput;
}

export function buildOfflineEvent({
  syntheticTxId,
  collectorId,
  mutation,
}: BuildOfflineEventArgs): OfflineEvent {
  const timestamp = toCanonicalTimestamp(new Date().toISOString());
  const eventType = mutationTypeToEventType(mutation.kind);
  const payload = mutationToRpcPayload(mutation, syntheticTxId);

  return {
    eventId: syntheticTxId,
    eventType,
    collectorId,
    entityId: syntheticTxId,
    timestamp,
    actor: collectorId,
    source: "offline_reconciled",
    payload,
  };
}

function mutationTypeToEventType(kind: OfflineMutationInput["kind"]): OfflineEvent["eventType"] {
  switch (kind) {
    case "contribution":
      return "transaction.contribution_recorded";
    case "rattrapage":
      return "transaction.rattrapage_recorded";
    case "advance":
      return "transaction.advance_recorded";
  }
}

/** Serialise the mutation input in snake_case + with `p_*` keys so the
 *  reconciler (Story 8.4) can shallow-spread it onto the RPC call. The
 *  synthetic txId is included as `p_event_id` so the server can dedup. */
function mutationToRpcPayload(
  mutation: OfflineMutationInput,
  syntheticTxId: string,
): Record<string, unknown> {
  if (mutation.kind === "contribution") {
    return {
      p_event_id: syntheticTxId,
      p_member_id: mutation.input.memberId,
      p_cycle_id: mutation.input.cycleId,
      p_amount: mutation.input.amount,
      p_cycle_day: mutation.input.cycleDay,
    };
  }
  if (mutation.kind === "rattrapage") {
    return {
      p_event_id: syntheticTxId,
      p_member_id: mutation.input.memberId,
      p_cycle_id: mutation.input.cycleId,
      p_daily_amount: mutation.input.dailyAmount,
      p_cycle_day: mutation.input.cycleDay,
      p_days_covered: mutation.input.daysCovered,
    };
  }
  // advance
  return {
    p_event_id: syntheticTxId,
    p_member_id: mutation.input.memberId,
    p_cycle_id: mutation.input.cycleId,
    p_amount: mutation.input.amount,
    p_cycle_day: mutation.input.cycleDay,
    p_motive: mutation.input.motive,
    p_saver_acknowledged: mutation.input.saverAcknowledged,
  };
}
