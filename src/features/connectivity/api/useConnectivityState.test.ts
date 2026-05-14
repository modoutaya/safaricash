// Story 8.1 — useConnectivityState hook tests.
//
// Covers initial-online detection, online/offline window events, cleanup
// on unmount, and the state-derivation priority order (offline > failed >
// syncing > connected).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    setOnlineFlag(true);
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

  it("Story 8.1 placeholders — pendingCount === 0 and hasFailed === false always", () => {
    const { result } = renderHook(() => useConnectivityState());
    // Story 8.3 will replace pendingCount; Story 8.4 will replace
    // hasFailed. Until then the contract holds these constants.
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
