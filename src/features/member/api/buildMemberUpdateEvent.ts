// Story 8.6 / FR40 — OfflineEvent builder for an offline member edit.
//
// Mirrors Story 8.3's buildOfflineEvent (transactions) but for the member
// surface: a `member.updated` event whose `entityId` is the EXISTING member
// id and whose `eventId` is a fresh idempotency UUID (distinct — a member
// is updated many times, each edit a separate event). The payload is in the
// snake_case `p_*` shape the `update_member` RPC expects so Story 8.4's
// reconciler can shallow-spread it onto the RPC call.
//
// See: 8-6-offline-member-lookup-edit.md AC #13.

import { toCanonicalTimestamp } from "@/domain/audit/hashChain";
import type { OfflineEvent } from "@/infrastructure/sync";

export interface BuildMemberUpdateEventArgs {
  /** Fresh UUID v4 (`crypto.randomUUID()`) — used as the IDB `eventId` AND
   *  the RPC `p_event_id` idempotency key. */
  eventId: string;
  /** auth.uid() of the writing collector — never null (the caller
   *  short-circuits with an `unauthorized` error before reaching here). */
  collectorId: string;
  /** The id of the member being edited (the event's `entityId`). */
  memberId: string;
  name: string;
  phoneNumber: string;
  dailyAmount: number;
}

export function buildMemberUpdateEvent({
  eventId,
  collectorId,
  memberId,
  name,
  phoneNumber,
  dailyAmount,
}: BuildMemberUpdateEventArgs): OfflineEvent {
  return {
    eventId,
    eventType: "member.updated",
    collectorId,
    entityId: memberId,
    timestamp: toCanonicalTimestamp(new Date().toISOString()),
    actor: collectorId,
    source: "offline_reconciled",
    payload: {
      p_event_id: eventId,
      p_id: memberId,
      p_name: name,
      p_phone_number: phoneNumber,
      p_daily_amount: dailyAmount,
    },
  };
}
