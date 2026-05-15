// Story 8.1 — useConnectivityState hook tests.
// Story 8.3 — pendingCount subscription tests.
//
// Covers initial-online detection, online/offline window events, cleanup
// on unmount, the state-derivation priority order (offline > failed >
// syncing > connected), and the Story 8.3 real-pendingCount subscription
// (BroadcastChannel + countEvents partitioned by useCollectorId).

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const countEventsMock = vi.fn();
const useCollectorIdMock = vi.fn();

vi.mock("@/infrastructure/sync", () => ({
  countEvents: (id: string) => countEventsMock(id),
  EVENT_LOG_CHANNEL_NAME: "safaricash-event-log",
}));

vi.mock("@/features/auth/api/useCollectorId", () => ({
  useCollectorId: () => useCollectorIdMock(),
}));

import { deriveState, useConnectivityState } from "./useConnectivityState";

const originalDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "onLine");

function setOnlineFlag(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

function restoreOnlineFlag(): void {
  if (originalDescriptor) {
    Object.defineProperty(window.navigator, "onLine", originalDescriptor);
  } else {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
  }
}

describe("useConnectivityState", () => {
  beforeEach(() => {
    localStorage.clear();
    setOnlineFlag(true);
    // Story 8.3 mocks: by default no session → pendingCount stays 0
    // so the existing Story 8.1 tests don't see surprise async work.
    useCollectorIdMock.mockReset();
    useCollectorIdMock.mockReturnValue(null);
    countEventsMock.mockReset();
    countEventsMock.mockResolvedValue(0);
  });

  afterEach(() => {
    restoreOnlineFlag();
  });

  it("initial mount with navigator.onLine === true → state='connected'", () => {
    const { result } = renderHook(() => useConnectivityState());
    expect(result.current.state).toBe("connected");
    expect(result.current.online).toBe(true);
    expect(result.current.pendingCount).toBe(0);
    expect(result.current.hasFailed).toBe(false);
  });

  it("initial mount with navigator.onLine === false → state='offline'", () => {
    setOnlineFlag(false);
    const { result } = renderHook(() => useConnectivityState());
    expect(result.current.state).toBe("offline");
    expect(result.current.online).toBe(false);
  });

  it("window 'offline' event → state transitions to 'offline'", () => {
    const { result } = renderHook(() => useConnectivityState());
    expect(result.current.state).toBe("connected");
    act(() => {
      setOnlineFlag(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.state).toBe("offline");
    expect(result.current.online).toBe(false);
  });

  it("window 'online' event → state transitions back to 'connected'", () => {
    setOnlineFlag(false);
    const { result } = renderHook(() => useConnectivityState());
    expect(result.current.state).toBe("offline");
    act(() => {
      setOnlineFlag(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current.state).toBe("connected");
    expect(result.current.online).toBe(true);
  });

  it("unmount removes both online/offline event listeners (no leak)", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useConnectivityState());
    unmount();
    const calls = removeSpy.mock.calls.map((c) => c[0]);
    expect(calls).toContain("online");
    expect(calls).toContain("offline");
    removeSpy.mockRestore();
  });

  it("no session → pendingCount 0 and hasFailed false", () => {
    const { result } = renderHook(() => useConnectivityState());
    // collectorId is null (default mock) → no outbox to track, never stalled.
    expect(result.current.pendingCount).toBe(0);
    expect(result.current.hasFailed).toBe(false);
  });
});

// Code-review patch #1 — exported pure function tested directly so the
// state-priority contract (AC #3: offline > sync-failed > syncing >
// connected) is locked down without depending on the Story 8.3/8.4
// placeholders being non-default in the hook itself.
describe("deriveState (pure-function contract — AC #3 priority)", () => {
  it("connected — online + no pending + no failure", () => {
    expect(deriveState(true, 0, false)).toBe("connected");
  });

  it("syncing — online + pending > 0 + no failure", () => {
    expect(deriveState(true, 1, false)).toBe("syncing");
    expect(deriveState(true, 42, false)).toBe("syncing");
  });

  it("sync-failed — online + failure (regardless of pending)", () => {
    expect(deriveState(true, 0, true)).toBe("sync-failed");
    expect(deriveState(true, 3, true)).toBe("sync-failed");
  });

  it("offline — offline always wins (regardless of pending or failure)", () => {
    expect(deriveState(false, 0, false)).toBe("offline");
    expect(deriveState(false, 5, false)).toBe("offline");
    expect(deriveState(false, 0, true)).toBe("offline");
    expect(deriveState(false, 5, true)).toBe("offline");
  });

  it("priority — sync-failed beats syncing when online + pending + failed", () => {
    // online=true, pendingCount>0, hasFailed=true → sync-failed wins.
    expect(deriveState(true, 7, true)).toBe("sync-failed");
  });
});

describe("useConnectivityState — Story 8.3 pendingCount subscription", () => {
  const COLLECTOR = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    localStorage.clear();
    setOnlineFlag(true);
    useCollectorIdMock.mockReset();
    countEventsMock.mockReset();
    countEventsMock.mockResolvedValue(0);
  });

  afterEach(() => {
    restoreOnlineFlag();
  });

  it("collectorId === null → pendingCount stays 0 (no countEvents call)", async () => {
    useCollectorIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useConnectivityState());
    // Let any microtask drain.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.pendingCount).toBe(0);
    expect(countEventsMock).not.toHaveBeenCalled();
  });

  it("collectorId present + 3 events → pendingCount === 3 after refresh", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    countEventsMock.mockResolvedValue(3);
    const { result } = renderHook(() => useConnectivityState());
    await waitFor(() => expect(result.current.pendingCount).toBe(3));
    expect(countEventsMock).toHaveBeenCalledWith(COLLECTOR);
  });

  it("BroadcastChannel message triggers a refresh (count goes 0 → 1)", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    countEventsMock.mockResolvedValueOnce(0); // initial
    const { result } = renderHook(() => useConnectivityState());
    await waitFor(() => expect(result.current.pendingCount).toBe(0));

    countEventsMock.mockResolvedValueOnce(1); // next call after broadcast
    const channel = new BroadcastChannel("safaricash-event-log");
    channel.postMessage({ type: "append", ts: Date.now() });
    channel.close();

    await waitFor(() => expect(result.current.pendingCount).toBe(1));
  });

  it("BroadcastChannel delete message refreshes downward (count goes 2 → 1)", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    countEventsMock.mockResolvedValueOnce(2); // initial
    const { result } = renderHook(() => useConnectivityState());
    await waitFor(() => expect(result.current.pendingCount).toBe(2));

    countEventsMock.mockResolvedValueOnce(1);
    const channel = new BroadcastChannel("safaricash-event-log");
    channel.postMessage({ type: "delete", ts: Date.now() });
    channel.close();

    await waitFor(() => expect(result.current.pendingCount).toBe(1));
  });

  it("unmount removes the BroadcastChannel listener (no further refresh on post)", async () => {
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    countEventsMock.mockResolvedValue(0);
    const { result, unmount } = renderHook(() => useConnectivityState());
    await waitFor(() => expect(result.current.pendingCount).toBe(0));
    const callsBeforeUnmount = countEventsMock.mock.calls.length;

    unmount();

    // Post a CONTROL message first to a separately-attached channel —
    // when we observe IT in our own listener we know any production
    // listener would have also fired by now. This deterministic
    // milestone replaces the previous setTimeout(30) sleep which could
    // flake on a loaded CI runner.
    const controlChannel = new BroadcastChannel("safaricash-event-log");
    const controlSeen = new Promise<void>((resolve) => {
      controlChannel.addEventListener("message", () => resolve(), { once: true });
    });
    const senderChannel = new BroadcastChannel("safaricash-event-log");
    senderChannel.postMessage({ type: "append", ts: Date.now() });
    senderChannel.close();
    await controlSeen;
    controlChannel.close();

    // If the production listener were still attached, countEvents would
    // have been called by now (the control message proves the channel
    // dispatched). It wasn't → listener was properly removed.
    expect(countEventsMock.mock.calls.length).toBe(callsBeforeUnmount);
  });
});

describe("useConnectivityState — Story 8.5 stalled-sync wiring", () => {
  const COLLECTOR = "33333333-3333-4333-8333-333333333333";
  const MARKER_KEY = `safaricash:sync:stalled-since:${COLLECTOR}`;

  beforeEach(() => {
    localStorage.clear();
    setOnlineFlag(true);
    useCollectorIdMock.mockReset();
    useCollectorIdMock.mockReturnValue(COLLECTOR);
    countEventsMock.mockReset();
    countEventsMock.mockResolvedValue(0);
  });

  afterEach(() => {
    restoreOnlineFlag();
    localStorage.clear();
  });

  it("online + non-empty queue past the stalled threshold → hasFailed + state 'sync-failed'", async () => {
    // Marker pre-seeded 20 min ago (simulates a queue that reconnected but
    // never drained — survives the app reload).
    localStorage.setItem(MARKER_KEY, String(Date.now() - 20 * 60 * 1000));
    countEventsMock.mockResolvedValue(2);
    const { result } = renderHook(() => useConnectivityState());
    await waitFor(() => expect(result.current.pendingCount).toBe(2));
    await waitFor(() => expect(result.current.hasFailed).toBe(true));
    expect(result.current.state).toBe("sync-failed");
  });

  it("offline wins over a would-be-stalled queue → state 'offline', hasFailed false", async () => {
    localStorage.setItem(MARKER_KEY, String(Date.now() - 20 * 60 * 1000));
    setOnlineFlag(false);
    countEventsMock.mockResolvedValue(2);
    const { result } = renderHook(() => useConnectivityState());
    await waitFor(() => expect(result.current.pendingCount).toBe(2));
    expect(result.current.hasFailed).toBe(false);
    expect(result.current.state).toBe("offline");
  });

  it("non-empty queue NOT yet past threshold → syncing, not sync-failed", async () => {
    countEventsMock.mockResolvedValue(1);
    const { result } = renderHook(() => useConnectivityState());
    await waitFor(() => expect(result.current.pendingCount).toBe(1));
    expect(result.current.hasFailed).toBe(false);
    expect(result.current.state).toBe("syncing");
  });
});
