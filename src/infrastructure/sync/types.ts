// Story 8.2 / FR40 / AR8 — offline event log shape.
//
// Mirror of architecture.md:582-595 — the same shape the audit-log row
// uses (src/domain/audit/event.ts:AuditEvent), minus `entityTable`. The
// reconciler (Story 8.4) will reconstruct the destination table from
// `eventType` (e.g. `transaction.contribution_recorded` → `transactions`),
// so we keep IDB rows lean.
//
// See: epics.md:1188-1201 (Story 8.2 BDD),
// architecture.md:582-595 (shared event payload structure),
// architecture.md:108 + 367-370 (event-sourced offline design).

import { z } from "zod";

/** Canonical UTC timestamp string format that Postgres + audit log emit.
 *  Microsecond precision, trailing `Z`. Generated client-side via
 *  `toCanonicalTimestamp(new Date().toISOString())` from
 *  `@/domain/audit/hashChain`. */
const CANONICAL_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export type OfflineEventType =
  | "transaction.contribution_recorded"
  | "transaction.rattrapage_recorded"
  | "transaction.advance_recorded"
  | "transaction.undone"
  | "member.created"
  | "member.updated"
  | "member.deleted";

export interface OfflineEvent {
  /** Client-generated UUID v4 (idempotency key for server-side dedup). */
  eventId: string;
  /** `{entity}.{action_past_tense}` — see OfflineEventType union. */
  eventType: OfflineEventType;
  /** Owning collector — partition key for the `byCollectorAndTime` index. */
  collectorId: string;
  /** ID of the affected row (transaction / member). Story 8.4's reconciler
   *  contract assumes the caller pre-generates a UUID the server RPC will
   *  accept; Story 8.2 just persists whatever the caller passes. */
  entityId: string;
  /** Microsecond-precision UTC string per CANONICAL_TIMESTAMP_REGEX. */
  timestamp: string;
  /** auth.uid() of the writing collector. NEVER `"system"` on the client. */
  actor: string;
  /** Origin tag. Captured as `"offline_reconciled"` on the client; the
   *  audit-log trigger on the server overrides to `"online"` if the
   *  reconciler succeeds in real-time. */
  source: "online" | "offline_reconciled";
  /** Operation-specific payload — opaque to the event log; the consumer
   *  (Story 8.3 hook) validates against its own Zod schema. The event log
   *  only verifies it is a plain serialisable object. */
  payload: Record<string, unknown>;
}

export const offlineEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.enum([
    "transaction.contribution_recorded",
    "transaction.rattrapage_recorded",
    "transaction.advance_recorded",
    "transaction.undone",
    "member.created",
    "member.updated",
    "member.deleted",
  ]),
  collectorId: z.string().uuid(),
  entityId: z.string().uuid(),
  timestamp: z.string().regex(CANONICAL_TIMESTAMP_REGEX, "must be a canonical UTC timestamp"),
  actor: z.string().uuid(),
  source: z.enum(["online", "offline_reconciled"]),
  payload: z
    .record(z.string(), z.unknown())
    .refine(
      isStructuredCloneable,
      "payload must be structured-clone-serialisable (no Symbol / function / WeakMap)",
    ),
}) satisfies z.ZodType<OfflineEvent>;

/** Guard the payload against values that IDB's structured-clone algorithm
 *  will reject (Symbol, function, WeakMap, class instances with non-clonable
 *  internals). Without this check, a bad payload reaches `db.add()` and
 *  fails with DataCloneError → TRANSACTION_FAILED — a misleading code
 *  for what is really a validation issue at the caller boundary. */
function isStructuredCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}
