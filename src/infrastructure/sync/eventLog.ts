// Story 8.2 / FR40-43 / AR8 — IndexedDB offline event log.
//
// Append-only, durable persistence for write operations captured while
// the device is offline. Stories 8.3-8.6 consume this primitive:
//   - 8.3 appends events on the offline branch of the record-* hooks
//     and subscribes to countEvents() for the connectivity pill.
//   - 8.4's reconciler drains via listEvents() → server POST →
//     deleteEvent() on 2xx success.
//   - 8.5 may introduce a parallel retry-state store; this canonical
//     event log stays immutable.
//   - 8.6 reads the local read-model (out of scope here).
//
// See: spec _bmad-output/implementation-artifacts/8-2-indexeddb-event-log.md
//      epics.md:1188-1201, architecture.md:367-370 + 582-595 + 973-980.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import { offlineEventSchema, type OfflineEvent } from "./types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DB_NAME = "safaricash_event_log";
const DB_VERSION = 1;
const STORE_NAME = "events";
const INDEX_NAME = "byCollectorAndTime";

interface EventLogDbSchema extends DBSchema {
  events: {
    key: string; // eventId (keyPath)
    value: OfflineEvent;
    indexes: {
      byCollectorAndTime: [string, string]; // [collectorId, timestamp]
    };
  };
}

// ---------------------------------------------------------------------------
// Error contract (AC #11)
// ---------------------------------------------------------------------------

export type OfflineEventLogErrorCode =
  | "VALIDATION_FAILED"
  | "DUPLICATE_EVENT_ID"
  | "DB_OPEN_FAILED"
  | "QUOTA_EXCEEDED"
  | "TRANSACTION_FAILED";

export class OfflineEventLogError extends Error {
  readonly code: OfflineEventLogErrorCode;
  // Tighten the inherited `Error.cause` field to `readonly` so consumers can
  // rely on the contract that a captured cause never mutates. The actual
  // value is set by the ES2022 `super(message, { cause })` channel below.
  override readonly cause?: unknown;
  constructor(code: OfflineEventLogErrorCode, message: string, cause?: unknown) {
    // Use the ES2022 Error.cause channel rather than redeclaring the field
    // ourselves — keeps the class definition free of `override` ceremony
    // and matches the Stage-4 spec pattern.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "OfflineEventLogError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Singleton DB handle (AC #10, #16)
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBPDatabase<EventLogDbSchema>> | undefined;

/**
 * Open (or create) the singleton IDB DB. Idempotent — repeated calls return
 * the same Promise. Tests can call this directly; production callers do not
 * need to.
 *
 * @throws OfflineEventLogError with code `DB_OPEN_FAILED` if the upgrade /
 * open path throws.
 */
export function openEventLogDb(): Promise<IDBPDatabase<EventLogDbSchema>> {
  if (dbPromise) return dbPromise;
  dbPromise = openDB<EventLogDbSchema>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "eventId",
          autoIncrement: false,
        });
        store.createIndex(INDEX_NAME, ["collectorId", "timestamp"], { unique: false });
      }
    },
    // Multi-tab v2 upgrade safety: when a future story bumps DB_VERSION,
    // tabs holding the older connection must close to let the upgrading
    // tab proceed, otherwise the upgrading tab hangs forever (the IDB
    // spec's "blocked" state). Close the local handle on `versionchange`
    // and let the next call re-open at the new version.
    blocking() {
      void _resetEventLogDbForTests();
    },
    // The browser forcibly closed our connection (DevTools "Clear site
    // data", origin storage eviction, etc.). Drop the stale handle so the
    // next caller re-opens a fresh connection instead of failing every
    // subsequent operation with TRANSACTION_FAILED until page reload.
    terminated() {
      dbPromise = undefined;
    },
  }).catch((cause: unknown) => {
    // Clear so a later caller can retry after a transient failure.
    dbPromise = undefined;
    const message = cause instanceof Error ? cause.message : "unknown IDB open failure";
    throw new OfflineEventLogError(
      "DB_OPEN_FAILED",
      `failed to open event log DB: ${message}`,
      cause,
    );
  });
  return dbPromise;
}

/** Test-only helper. Resets the memoised promise and closes the underlying
 *  DB so the next `openEventLogDb()` performs a fresh upgrade. The returned
 *  promise resolves only AFTER the underlying `db.close()` completes, so
 *  callers (notably `beforeEach`) can deterministically await teardown
 *  before opening a fresh connection — important for real browsers where
 *  racing close + open emits IDB `blocked` events. */
export async function _resetEventLogDbForTests(): Promise<void> {
  const pending = dbPromise;
  dbPromise = undefined;
  if (!pending) return;
  try {
    const db = await pending;
    db.close();
  } catch {
    /* swallow — we're tearing down a possibly-already-failed open */
  }
}

// ---------------------------------------------------------------------------
// CRUD surface (AC #8)
// ---------------------------------------------------------------------------

/**
 * Append a single event. Validates via Zod at the boundary.
 *
 * @throws OfflineEventLogError VALIDATION_FAILED on schema mismatch.
 * @throws OfflineEventLogError DUPLICATE_EVENT_ID if `event.eventId` already
 * exists in the store (IDB ConstraintError on `add`).
 * @throws OfflineEventLogError QUOTA_EXCEEDED if the browser refuses the
 * write due to storage pressure.
 * @throws OfflineEventLogError TRANSACTION_FAILED for any other IDB error.
 */
export async function appendEvent(event: OfflineEvent): Promise<void> {
  const parsed = offlineEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new OfflineEventLogError(
      "VALIDATION_FAILED",
      `offline event failed schema: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      parsed.error,
    );
  }

  const db = await openEventLogDb();
  try {
    // .add() (not .put()) enforces "fail on duplicate key" at the IDB layer.
    await db.add(STORE_NAME, parsed.data);
  } catch (cause: unknown) {
    throw mapIdbError(cause, `appendEvent(eventId=${parsed.data.eventId})`);
  }
}

/**
 * Return all events for a collector, sorted by `timestamp ASC` then by
 * `eventId ASC` (stable tiebreak). Used by Story 8.4's reconciler.
 */
export async function listEvents(collectorId: string): Promise<OfflineEvent[]> {
  requireCollectorId(collectorId, "listEvents");
  const db = await openEventLogDb();
  // High sentinel `￿` (U+FFFF) works because timestamps are ISO 8601
  // strings — their lex order matches chronological order, and U+FFFF
  // is past any valid date character.
  const range = IDBKeyRange.bound([collectorId, ""], [collectorId, "￿"]);
  let rows: OfflineEvent[];
  try {
    rows = await db.getAllFromIndex(STORE_NAME, INDEX_NAME, range);
  } catch (cause: unknown) {
    throw mapIdbError(cause, `listEvents(collectorId=${collectorId})`);
  }
  // `getAllFromIndex` returns rows in index key order, which is already
  // `[collectorId, timestamp] ASC`. We additionally tiebreak on eventId
  // for determinism across IDB implementations.
  return rows.sort((a, b) => {
    if (a.timestamp === b.timestamp)
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    return a.timestamp < b.timestamp ? -1 : 1;
  });
}

/** Fetch a single event by ID. Returns `undefined` when not found — does
 *  not throw on miss (callers distinguish "no such event" from "DB error"). */
export async function getEvent(eventId: string): Promise<OfflineEvent | undefined> {
  const db = await openEventLogDb();
  try {
    return await db.get(STORE_NAME, eventId);
  } catch (cause: unknown) {
    throw mapIdbError(cause, `getEvent(eventId=${eventId})`);
  }
}

/** O(log n) count of events for a collector via the byCollectorAndTime
 *  index. Source of truth for the Story 8.3 pendingCount subscription. */
export async function countEvents(collectorId: string): Promise<number> {
  requireCollectorId(collectorId, "countEvents");
  const db = await openEventLogDb();
  const range = IDBKeyRange.bound([collectorId, ""], [collectorId, "￿"]);
  try {
    return await db.countFromIndex(STORE_NAME, INDEX_NAME, range);
  } catch (cause: unknown) {
    throw mapIdbError(cause, `countEvents(collectorId=${collectorId})`);
  }
}

/** Remove a single event after the reconciler confirms server-side commit.
 *  Idempotent — deleting a non-existent eventId is a no-op (matches the
 *  at-least-once semantics Story 8.4 relies on). */
export async function deleteEvent(eventId: string): Promise<void> {
  const db = await openEventLogDb();
  try {
    await db.delete(STORE_NAME, eventId);
  } catch (cause: unknown) {
    throw mapIdbError(cause, `deleteEvent(eventId=${eventId})`);
  }
}

/** TEST HELPER — wipes the `events` store. Never call from production. */
export async function _clearAllEvents(): Promise<void> {
  const db = await openEventLogDb();
  try {
    await db.clear(STORE_NAME);
  } catch (cause: unknown) {
    throw mapIdbError(cause, "_clearAllEvents()");
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** UUID v4 shape — same regex Zod uses in the schema, hoisted so the
 *  collectorId guard doesn't re-parse the schema for each call. */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireCollectorId(collectorId: string, context: string): void {
  if (
    typeof collectorId !== "string" ||
    collectorId.length === 0 ||
    !UUID_V4_REGEX.test(collectorId)
  ) {
    throw new OfflineEventLogError(
      "VALIDATION_FAILED",
      `${context}: collectorId must be a non-empty UUID string (got ${JSON.stringify(collectorId)})`,
    );
  }
}

function mapIdbError(cause: unknown, context: string): OfflineEventLogError {
  if (cause instanceof OfflineEventLogError) return cause;
  // Read `.name` defensively: in real browsers IDB rejections are
  // DOMException instances; in jsdom + fake-indexeddb they are plain
  // Error instances; in pathological cases (degraded `idb` versions,
  // primitive throws) we want to fall back to TRANSACTION_FAILED rather
  // than crashing on a missing property.
  const name =
    cause != null && typeof (cause as Record<string, unknown>).name === "string"
      ? (cause as { name: string }).name
      : undefined;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (name === "ConstraintError") {
    return new OfflineEventLogError(
      "DUPLICATE_EVENT_ID",
      `${context}: eventId already exists (${message})`,
      cause,
    );
  }
  if (name === "QuotaExceededError") {
    return new OfflineEventLogError("QUOTA_EXCEEDED", `${context}: IDB quota exceeded`, cause);
  }
  return new OfflineEventLogError("TRANSACTION_FAILED", `${context}: ${message}`, cause);
}
