// Story 8.2 — public surface of the offline event-log infrastructure.
//
// Consumers (Stories 8.3+) import from `@/infrastructure/sync` only — the
// underlying `eventLog.ts` and `types.ts` modules are implementation
// details that may evolve (e.g., schema v2 migration).

// Story 8.2 — public surface. Test-only helpers (`_clearAllEvents`,
// `_resetEventLogDbForTests`) are NOT re-exported from this barrel; test
// files import them via the deep path `@/infrastructure/sync/eventLog` to
// keep the production surface clean.

export {
  appendEvent,
  countEvents,
  deleteEvent,
  EVENT_LOG_CHANNEL_NAME,
  getEvent,
  listEvents,
  OfflineEventLogError,
  openEventLogDb,
} from "./eventLog";
export type { EventLogChangeMessage, OfflineEventLogErrorCode } from "./eventLog";
export { offlineEventSchema } from "./types";
export type { OfflineEvent, OfflineEventType } from "./types";

// Story 8.4 — reconciler + backoff helpers.
export { computeBackoffMs } from "./backoff";
export { classifyReplayError, replayPendingEvents, stopReplay } from "./reconciler";
export type { ReplayErrorCode, ReplayResult } from "./reconciler";
