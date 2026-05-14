// Story 8.4 — reconciler.ts unit tests.
//
// Validates the drain algorithm in 17 scenarios. `fake-indexeddb` is
// registered by vitest.setup.ts (Story 8.2 polyfill); `supabase.rpc` is
// mocked at module scope so tests control the per-event outcome.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { _clearAllEvents, _resetEventLogDbForTests, appendEvent, listEvents } from "./eventLog";
import {
  _resetReconcilerForTests,
  classifyReplayError,
  replayPendingEvents,
  stopReplay,
} from "./reconciler";
import type { OfflineEvent } from "./types";

const COLLECTOR = "11111111-1111-4111-8111-111111111111";

function makeContribEvent(opts: { idx: number; eventId?: string }): OfflineEvent {
  const mm = String(opts.idx % 60).padStart(2, "0");
  // Story 8.4 code-review patch HIGH #2 — generate ONCE so eventId and
  // payload.p_event_id are guaranteed identical (mirrors Story 8.3's
  // buildOfflineEvent which writes the SAME synthetic UUID into both).
  // The previous fixture used 2 independent crypto.randomUUID() calls
  // → tests that asserted idempotency passed vacuously.
  const sharedEventId = opts.eventId ?? crypto.randomUUID();
  return {
    eventId: sharedEventId,
    eventType: "transaction.contribution_recorded",
    collectorId: COLLECTOR,
    entityId: sharedEventId,
    timestamp: `2026-05-15T10:${mm}:00.000000Z`,
    actor: COLLECTOR,
    source: "offline_reconciled",
    payload: {
      p_event_id: sharedEventId,
      p_member_id: "22222222-2222-4222-8222-222222222222",
      p_cycle_id: "33333333-3333-4333-8333-333333333333",
      p_amount: 500,
      p_cycle_day: (opts.idx % 30) + 1,
    },
  };
}

beforeEach(async () => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: crypto.randomUUID(), error: null });
  await _resetEventLogDbForTests();
  await _clearAllEvents();
  await _resetReconcilerForTests();
});

afterEach(async () => {
  await _resetEventLogDbForTests();
  await _resetReconcilerForTests();
});

describe("reconciler — happy paths", () => {
  it("empty queue → no RPC calls, all counts zero", async () => {
    const result = await replayPendingEvents(COLLECTOR);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.attempted).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.networkFailures).toBe(0);
  });

  it("3 events all succeed → 3 RPC calls in order + queue empties", async () => {
    await appendEvent(makeContribEvent({ idx: 0 }));
    await appendEvent(makeContribEvent({ idx: 1 }));
    await appendEvent(makeContribEvent({ idx: 2 }));

    const result = await replayPendingEvents(COLLECTOR);

    expect(rpcMock).toHaveBeenCalledTimes(3);
    expect(rpcMock).toHaveBeenNthCalledWith(
      1,
      "record_contribution",
      expect.objectContaining({ p_cycle_day: 1 }),
    );
    expect(rpcMock).toHaveBeenNthCalledWith(
      3,
      "record_contribution",
      expect.objectContaining({ p_cycle_day: 3 }),
    );
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(await listEvents(COLLECTOR)).toHaveLength(0);
  });
});

describe("reconciler — error classification", () => {
  it("mid-drain TypeError → stops drain, queue retains remaining events", async () => {
    await appendEvent(makeContribEvent({ idx: 0 }));
    await appendEvent(makeContribEvent({ idx: 1 }));
    await appendEvent(makeContribEvent({ idx: 2 }));

    rpcMock
      .mockResolvedValueOnce({ data: crypto.randomUUID(), error: null })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await replayPendingEvents(COLLECTOR);

    expect(result.succeeded).toBe(1);
    expect(result.networkFailures).toBe(1);
    expect(result.attempted).toBe(2); // event 3 never attempted
    // 2 events remain (the one that failed + the unattempted one).
    expect(await listEvents(COLLECTOR)).toHaveLength(2);
  });

  it("5xx PostgrestError → classified as network, drain stops", async () => {
    await appendEvent(makeContribEvent({ idx: 0 }));
    await appendEvent(makeContribEvent({ idx: 1 }));

    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { status: 503, message: "service unavailable" },
    });

    const result = await replayPendingEvents(COLLECTOR);

    expect(result.networkFailures).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(await listEvents(COLLECTOR)).toHaveLength(2); // queue intact
  });

  it("validation error (23514 cycle_closed) → skip + continue", async () => {
    await appendEvent(makeContribEvent({ idx: 0 }));
    await appendEvent(makeContribEvent({ idx: 1 }));
    await appendEvent(makeContribEvent({ idx: 2 }));

    rpcMock
      .mockResolvedValueOnce({ data: crypto.randomUUID(), error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "23514", message: "cycle_closed: …" },
      })
      .mockResolvedValueOnce({ data: crypto.randomUUID(), error: null });

    const result = await replayPendingEvents(COLLECTOR);

    expect(result.succeeded).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.attempted).toBe(3);
    // The skipped event stays in the queue (will surface to Story 8.5).
    expect(await listEvents(COLLECTOR)).toHaveLength(1);
  });

  it("unauthorized (42501) → drain stops, nothing deleted past it", async () => {
    await appendEvent(makeContribEvent({ idx: 0 }));
    await appendEvent(makeContribEvent({ idx: 1 }));

    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "permission denied" },
    });

    const result = await replayPendingEvents(COLLECTOR);

    expect(result.succeeded).toBe(0);
    // Story 8.4 code-review patch — unauthorized is now `sessionFailures`,
    // not `networkFailures` (Story 8.5 will distinguish in its retry UI).
    expect(result.sessionFailures).toBe(1);
    expect(result.networkFailures).toBe(0);
    expect(await listEvents(COLLECTOR)).toHaveLength(2);
  });

  it("idempotent replay — server returns existing id → deleteEvent still fires", async () => {
    const event = makeContribEvent({ idx: 0 });
    await appendEvent(event);

    // Server returns the existing transaction id (idempotency hit).
    const existingTxId = crypto.randomUUID();
    rpcMock.mockResolvedValueOnce({ data: existingTxId, error: null });

    const result = await replayPendingEvents(COLLECTOR);

    expect(result.succeeded).toBe(1);
    expect(await listEvents(COLLECTOR)).toHaveLength(0);
  });
});

describe("reconciler — concurrency + control", () => {
  it("single-in-flight — two concurrent calls share the same promise", async () => {
    await appendEvent(makeContribEvent({ idx: 0 }));
    // Slow down the RPC so the second call hits the in-flight guard.
    rpcMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ data: crypto.randomUUID(), error: null }), 50),
        ),
    );

    const a = replayPendingEvents(COLLECTOR);
    const b = replayPendingEvents(COLLECTOR);
    // Same promise — Object.is identity.
    expect(a).toBe(b);

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA).toEqual(resultB);
    expect(rpcMock).toHaveBeenCalledTimes(1); // only ONE drain ran
  });

  it("stopReplay — current event finishes, loop breaks at next iteration", async () => {
    await appendEvent(makeContribEvent({ idx: 0 }));
    await appendEvent(makeContribEvent({ idx: 1 }));
    await appendEvent(makeContribEvent({ idx: 2 }));

    rpcMock.mockImplementation(async () => {
      // Stop is requested after the FIRST event resolves but before the
      // loop checks `stopRequested` at the top of the next iteration.
      stopReplay();
      return { data: crypto.randomUUID(), error: null };
    });

    const result = await replayPendingEvents(COLLECTOR);

    // First event completes; loop exits before event 2.
    expect(result.succeeded).toBe(1);
    expect(result.attempted).toBe(1);
    expect(await listEvents(COLLECTOR)).toHaveLength(2);
  });
});

describe("reconciler — unsupported event types", () => {
  it("transaction.undone event → skipped (Story 8.x will own)", async () => {
    const event: OfflineEvent = {
      ...makeContribEvent({ idx: 0 }),
      eventType: "transaction.undone",
    };
    await appendEvent(event);

    const result = await replayPendingEvents(COLLECTOR);

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(await listEvents(COLLECTOR)).toHaveLength(1); // stays in queue
  });

  it("member.created event → skipped (Story 8.6 will own)", async () => {
    const event: OfflineEvent = {
      ...makeContribEvent({ idx: 0 }),
      eventType: "member.created",
    };
    await appendEvent(event);

    const result = await replayPendingEvents(COLLECTOR);

    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(await listEvents(COLLECTOR)).toHaveLength(1);
  });
});

describe("reconciler — perf budget (NFR-P6 functional check)", () => {
  it("drains 150 events end-to-end without error", async () => {
    // NFR-P6 functional check (the full 150-event spec). Pure-mock RPC
    // makes this fast even at 150 events (~1 ms each in jsdom). The
    // perf BUDGET (p95 ≤ 90 s on real WAEMU 3G) is measured separately
    // in the Playwright spec against a real Supabase stack.
    for (let i = 0; i < 150; i += 1) {
      await appendEvent(makeContribEvent({ idx: i }));
    }

    const result = await replayPendingEvents(COLLECTOR);

    expect(result.attempted).toBe(150);
    expect(result.succeeded).toBe(150);
    expect(await listEvents(COLLECTOR)).toHaveLength(0);
  });
});

describe("classifyReplayError", () => {
  it("classifies TypeError as network", () => {
    expect(classifyReplayError(new TypeError("Failed to fetch"))).toBe("network");
  });

  it("classifies 5xx status as network", () => {
    expect(classifyReplayError({ status: 503, message: "service unavailable" })).toBe("network");
  });

  it("classifies 42501 as unauthorized", () => {
    expect(classifyReplayError({ code: "42501" })).toBe("unauthorized");
  });

  it("classifies 23514 as validation", () => {
    expect(classifyReplayError({ code: "23514", message: "cycle_closed: …" })).toBe("validation");
  });

  it("falls back to unknown for unrecognised shapes", () => {
    expect(classifyReplayError({ message: "boom" })).toBe("unknown");
    expect(classifyReplayError(null)).toBe("unknown");
  });
});
