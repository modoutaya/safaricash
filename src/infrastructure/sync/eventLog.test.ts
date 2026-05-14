// Story 8.2 — IndexedDB event log unit tests.
//
// Covers AC #19 (14 cases): round-trip, validation, duplicate, partition,
// cross-reload durability, cross-sign-out durability, count, delete,
// _clearAllEvents helper, concurrent appends, getEvent miss, error class
// identity, crash simulation, index range correctness.
//
// `fake-indexeddb` is registered via vitest.setup.ts and gives jsdom the
// IDBFactory + IDBKeyRange globals we rely on here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Supabase client mock — needed by the AC #14 sign-out assertions below
// (the rest of the tests don't touch supabase). Mirrors the pattern in
// src/features/auth/api/signOut.test.ts:11-18.
// ---------------------------------------------------------------------------

const rpcMock = vi.fn();
const signOutSpy = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
    auth: {
      signOut: (opts?: unknown) => signOutSpy(opts),
    },
  },
}));

import {
  _clearAllEvents,
  appendEvent,
  countEvents,
  deleteEvent,
  getEvent,
  listEvents,
  OfflineEventLogError,
  openEventLogDb,
  _resetEventLogDbForTests,
} from "./eventLog";
import type { OfflineEvent } from "./types";

const COLLECTOR_A = "11111111-1111-4111-8111-111111111111";
const COLLECTOR_B = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

function makeEvent(overrides: Partial<OfflineEvent> = {}): OfflineEvent {
  return {
    eventId: overrides.eventId ?? crypto.randomUUID(),
    eventType: overrides.eventType ?? "transaction.contribution_recorded",
    collectorId: overrides.collectorId ?? COLLECTOR_A,
    entityId: overrides.entityId ?? crypto.randomUUID(),
    timestamp: overrides.timestamp ?? "2026-05-15T10:00:00.000000Z",
    actor: overrides.actor ?? ACTOR,
    source: overrides.source ?? "offline_reconciled",
    payload: overrides.payload ?? { amount: 5_000 },
  };
}

beforeEach(async () => {
  // Fresh DB handle per test — eliminates cross-test state pollution.
  // Await the close BEFORE clearing so we don't race a close against the
  // new open (real browsers emit `blocked` events when these overlap).
  await _resetEventLogDbForTests();
  await _clearAllEvents();
  rpcMock.mockReset();
  signOutSpy.mockReset();
  rpcMock.mockResolvedValue({ data: null, error: null });
  signOutSpy.mockResolvedValue({ error: null });
});

afterEach(async () => {
  await _resetEventLogDbForTests();
});

describe("eventLog — round-trip + validation", () => {
  it("appendEvent → getEvent round-trip returns the same event", async () => {
    const event = makeEvent({ eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await appendEvent(event);
    const fetched = await getEvent(event.eventId);
    expect(fetched).toEqual(event);
  });

  it("appendEvent throws VALIDATION_FAILED on bad input", async () => {
    const bad = makeEvent();
    // Bypass the compile-time UUID check — the runtime Zod gate is what we're
    // exercising here.
    bad.eventId = "not-a-uuid";
    await expect(appendEvent(bad)).rejects.toMatchObject({
      name: "OfflineEventLogError",
      code: "VALIDATION_FAILED",
    });
  });

  it("appendEvent throws DUPLICATE_EVENT_ID on the same eventId", async () => {
    const event = makeEvent({ eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    await appendEvent(event);
    await expect(appendEvent({ ...event, payload: { changed: true } })).rejects.toMatchObject({
      name: "OfflineEventLogError",
      code: "DUPLICATE_EVENT_ID",
    });
  });

  it("appendEvent throws VALIDATION_FAILED on a non-structured-clonable payload", async () => {
    const bad = makeEvent({ payload: { handler: () => "boom" } });
    await expect(appendEvent(bad)).rejects.toMatchObject({
      name: "OfflineEventLogError",
      code: "VALIDATION_FAILED",
    });
  });
});

describe("eventLog — collectorId guard", () => {
  it("listEvents throws VALIDATION_FAILED on empty collectorId", async () => {
    await expect(listEvents("")).rejects.toMatchObject({
      name: "OfflineEventLogError",
      code: "VALIDATION_FAILED",
    });
  });

  it("listEvents throws VALIDATION_FAILED on non-UUID collectorId", async () => {
    await expect(listEvents("not-a-uuid")).rejects.toMatchObject({
      name: "OfflineEventLogError",
      code: "VALIDATION_FAILED",
    });
  });

  it("countEvents throws VALIDATION_FAILED on empty collectorId", async () => {
    await expect(countEvents("")).rejects.toMatchObject({
      name: "OfflineEventLogError",
      code: "VALIDATION_FAILED",
    });
  });
});

describe("eventLog — partition + ordering", () => {
  it("listEvents returns this collector's events in timestamp ASC, isolates other collectors", async () => {
    const a1 = makeEvent({ collectorId: COLLECTOR_A, timestamp: "2026-05-15T09:00:00.000000Z" });
    const a2 = makeEvent({ collectorId: COLLECTOR_A, timestamp: "2026-05-15T10:00:00.000000Z" });
    const a3 = makeEvent({ collectorId: COLLECTOR_A, timestamp: "2026-05-15T11:00:00.000000Z" });
    const b1 = makeEvent({ collectorId: COLLECTOR_B, timestamp: "2026-05-15T08:30:00.000000Z" });

    // Append out of order on purpose — listEvents must still sort.
    await appendEvent(a3);
    await appendEvent(b1);
    await appendEvent(a1);
    await appendEvent(a2);

    const fetched = await listEvents(COLLECTOR_A);
    expect(fetched.map((e) => e.timestamp)).toEqual([
      "2026-05-15T09:00:00.000000Z",
      "2026-05-15T10:00:00.000000Z",
      "2026-05-15T11:00:00.000000Z",
    ]);
    expect(fetched.find((e) => e.collectorId === COLLECTOR_B)).toBeUndefined();
  });

  it("countEvents returns the per-collector count, ignoring other partitions", async () => {
    await appendEvent(
      makeEvent({ collectorId: COLLECTOR_A, timestamp: "2026-05-15T09:00:00.000000Z" }),
    );
    await appendEvent(
      makeEvent({ collectorId: COLLECTOR_A, timestamp: "2026-05-15T09:30:00.000000Z" }),
    );
    await appendEvent(
      makeEvent({ collectorId: COLLECTOR_B, timestamp: "2026-05-15T08:00:00.000000Z" }),
    );
    expect(await countEvents(COLLECTOR_A)).toBe(2);
    expect(await countEvents(COLLECTOR_B)).toBe(1);
  });

  it("index range stays correct as the partitions grow", async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendEvent(
        makeEvent({
          collectorId: COLLECTOR_A,
          timestamp: `2026-05-15T10:0${i}:00.000000Z`,
        }),
      );
    }
    for (let i = 0; i < 3; i += 1) {
      await appendEvent(
        makeEvent({
          collectorId: COLLECTOR_B,
          timestamp: `2026-05-15T11:0${i}:00.000000Z`,
        }),
      );
    }
    expect(await countEvents(COLLECTOR_A)).toBe(5);
    expect(await countEvents(COLLECTOR_B)).toBe(3);
  });
});

describe("eventLog — durability", () => {
  it("events persist across an app reload (drop + reopen DB handle)", async () => {
    const events = [
      makeEvent({ timestamp: "2026-05-15T09:00:00.000000Z" }),
      makeEvent({ timestamp: "2026-05-15T09:30:00.000000Z" }),
      makeEvent({ timestamp: "2026-05-15T10:00:00.000000Z" }),
    ];
    for (const event of events) await appendEvent(event);

    // Simulate page reload: drop the cached promise + close the DB.
    await _resetEventLogDbForTests();

    // Next call re-opens the same on-disk DB; events should be intact.
    const recovered = await listEvents(COLLECTOR_A);
    expect(recovered).toHaveLength(3);
  });

  it("events survive a simulated sign-out / sign-in cycle (AC #14)", async () => {
    await appendEvent(makeEvent({ timestamp: "2026-05-15T09:00:00.000000Z" }));
    await appendEvent(makeEvent({ timestamp: "2026-05-15T09:30:00.000000Z" }));

    // Runtime assertion: invoke the real `signOut` flow against a mocked
    // Supabase client. The flow MUST NOT touch the event log.
    const { requestSignOut } = await import("@/features/auth/api/signOut");
    await requestSignOut("explicit");
    // Sanity: signOut actually ran (rules out a vacuous pass).
    expect(signOutSpy).toHaveBeenCalledWith({ scope: "local" });

    // The event log is untouched after signOut.
    expect(await countEvents(COLLECTOR_A)).toBe(2);

    // Simulate the natural app-restart that happens when the user signs
    // back in — drop the cached DB handle exactly as a fresh tab would.
    await _resetEventLogDbForTests();

    // Subsequent signIn() opens the same on-disk DB; events still there.
    const recovered = await listEvents(COLLECTOR_A);
    expect(recovered).toHaveLength(2);
  });

  it("static-grep guard: signOut.ts does NOT reference event-log mutators (AC #14)", async () => {
    // Reads the real auth/signOut source and asserts it never imports or
    // calls the event-log mutation helpers. If a future change adds such
    // a call, this test breaks — the guard catches the regression before
    // the runtime assertion above silently passes.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const signOutPath = path.resolve(__dirname, "../../features/auth/api/signOut.ts");
    const source = await fs.readFile(signOutPath, "utf8");
    expect(source).not.toMatch(/_clearAllEvents/);
    expect(source).not.toMatch(/_resetEventLogDbForTests/);
    expect(source).not.toMatch(/from\s+["']@\/infrastructure\/sync/);
  });

  it("crash mid-session: events appended before the crash are recoverable", async () => {
    const event = makeEvent({ eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    await appendEvent(event);

    // Simulate a tab kill: drop the cached handle. In production the kill
    // happens before any explicit close(); here we await close() because
    // the helper is designed for safe teardown. The earlier readwrite tx
    // already committed before appendEvent resolved, so the row is durable.
    await _resetEventLogDbForTests();

    const recovered = await getEvent(event.eventId);
    expect(recovered).toEqual(event);
  });
});

describe("eventLog — delete + helpers", () => {
  it("deleteEvent removes a stored event; subsequent getEvent returns undefined; idempotent on miss", async () => {
    const event = makeEvent({ eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    await appendEvent(event);
    await deleteEvent(event.eventId);
    expect(await getEvent(event.eventId)).toBeUndefined();
    // Idempotent: deleting a non-existent eventId is a no-op.
    await expect(deleteEvent(event.eventId)).resolves.toBeUndefined();
  });

  it("_clearAllEvents wipes the store across partitions", async () => {
    await appendEvent(makeEvent({ collectorId: COLLECTOR_A }));
    await appendEvent(makeEvent({ collectorId: COLLECTOR_B }));
    expect((await countEvents(COLLECTOR_A)) + (await countEvents(COLLECTOR_B))).toBe(2);

    await _clearAllEvents();

    expect(await countEvents(COLLECTOR_A)).toBe(0);
    expect(await countEvents(COLLECTOR_B)).toBe(0);
  });

  it("getEvent returns undefined for an unknown eventId (no throw)", async () => {
    const missing = await getEvent("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    expect(missing).toBeUndefined();
  });
});

describe("eventLog — concurrency + error class identity", () => {
  it("concurrent appends all resolve and all events are retrievable", async () => {
    const events = [
      makeEvent({ timestamp: "2026-05-15T10:00:00.000000Z" }),
      makeEvent({ timestamp: "2026-05-15T10:00:01.000000Z" }),
      makeEvent({ timestamp: "2026-05-15T10:00:02.000000Z" }),
    ];

    await Promise.all(events.map((event) => appendEvent(event)));

    const fetched = await listEvents(COLLECTOR_A);
    expect(fetched).toHaveLength(3);
    expect(new Set(fetched.map((e) => e.eventId))).toEqual(new Set(events.map((e) => e.eventId)));
  });

  it("OfflineEventLogError satisfies instanceof checks for typed-error consumers", async () => {
    const event = makeEvent({ eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    await appendEvent(event);

    try {
      await appendEvent(event); // duplicate eventId → throws
      throw new Error("expected appendEvent to throw on duplicate eventId");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(OfflineEventLogError);
      expect(err).toBeInstanceOf(Error);
      expect((err as OfflineEventLogError).code).toBe("DUPLICATE_EVENT_ID");
    }
  });
});

describe("eventLog — openEventLogDb singleton", () => {
  it("repeated calls return the same DB handle (memoised promise)", async () => {
    const a = await openEventLogDb();
    const b = await openEventLogDb();
    expect(a).toBe(b);
  });
});

describe("eventLog — error mapping (rare paths)", () => {
  it("QuotaExceededError on add surfaces as QUOTA_EXCEEDED", async () => {
    const db = await openEventLogDb();
    const event = makeEvent();
    const spy = vi
      .spyOn(db, "add")
      .mockRejectedValueOnce(Object.assign(new Error("quota"), { name: "QuotaExceededError" }));
    try {
      await expect(appendEvent(event)).rejects.toMatchObject({
        name: "OfflineEventLogError",
        code: "QUOTA_EXCEEDED",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a generic IDB error surfaces as TRANSACTION_FAILED", async () => {
    const db = await openEventLogDb();
    const spy = vi
      .spyOn(db, "getAllFromIndex")
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "UnknownError" }));
    try {
      await expect(listEvents(COLLECTOR_A)).rejects.toMatchObject({
        name: "OfflineEventLogError",
        code: "TRANSACTION_FAILED",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("re-throws an OfflineEventLogError as-is (no double-wrap)", async () => {
    const inner = new OfflineEventLogError("DB_OPEN_FAILED", "already wrapped");
    const db = await openEventLogDb();
    const spy = vi.spyOn(db, "delete").mockRejectedValueOnce(inner);
    try {
      await expect(deleteEvent(crypto.randomUUID())).rejects.toBe(inner);
    } finally {
      spy.mockRestore();
    }
  });

  it("getEvent surfaces IDB errors as TRANSACTION_FAILED", async () => {
    const db = await openEventLogDb();
    const spy = vi
      .spyOn(db, "get")
      .mockRejectedValueOnce(Object.assign(new Error("disk"), { name: "UnknownError" }));
    try {
      await expect(getEvent(crypto.randomUUID())).rejects.toMatchObject({
        name: "OfflineEventLogError",
        code: "TRANSACTION_FAILED",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("countEvents surfaces IDB errors as TRANSACTION_FAILED", async () => {
    const db = await openEventLogDb();
    const spy = vi
      .spyOn(db, "countFromIndex")
      .mockRejectedValueOnce(Object.assign(new Error("disk"), { name: "UnknownError" }));
    try {
      await expect(countEvents(COLLECTOR_A)).rejects.toMatchObject({
        name: "OfflineEventLogError",
        code: "TRANSACTION_FAILED",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("_clearAllEvents surfaces IDB errors as TRANSACTION_FAILED", async () => {
    const db = await openEventLogDb();
    const spy = vi
      .spyOn(db, "clear")
      .mockRejectedValueOnce(Object.assign(new Error("disk"), { name: "UnknownError" }));
    try {
      await expect(_clearAllEvents()).rejects.toMatchObject({
        name: "OfflineEventLogError",
        code: "TRANSACTION_FAILED",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("eventLog — DB_OPEN_FAILED", () => {
  it("a rejecting openDB surfaces as DB_OPEN_FAILED", async () => {
    // Isolate the mock to this test only by dynamic-importing a fresh copy
    // of the module after vi.doMock takes effect. The other tests in this
    // file see the real `idb` module.
    vi.resetModules();
    vi.doMock("idb", () => ({
      openDB: vi.fn().mockRejectedValue(new Error("simulated open failure")),
    }));
    try {
      const fresh = await import("./eventLog");
      await expect(fresh.openEventLogDb()).rejects.toMatchObject({
        name: "OfflineEventLogError",
        code: "DB_OPEN_FAILED",
      });
    } finally {
      // Flush the module registry FIRST so the next `import` doesn't grab
      // a half-stale registry between the unmock and the registry reset.
      vi.resetModules();
      vi.doUnmock("idb");
    }
  });
});

describe("eventLog — sort tiebreak", () => {
  it("listEvents tiebreaks identical timestamps by eventId ASC", async () => {
    const ts = "2026-05-15T10:00:00.000000Z";
    const b = makeEvent({ eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", timestamp: ts });
    const a = makeEvent({ eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", timestamp: ts });
    const c = makeEvent({ eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", timestamp: ts });

    // Insert order ≠ sort order — exercises the comparator's tiebreak branches.
    await appendEvent(b);
    await appendEvent(a);
    await appendEvent(c);

    const fetched = await listEvents(COLLECTOR_A);
    expect(fetched.map((e) => e.eventId)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
  });
});
