// Story 8.5 — useStalledSync hook tests.
//
// Covers the NFR-P7 15-minute threshold, the reload-durable localStorage
// marker, the offline-never-stalled rule, marker clearing on drain /
// sign-out, the threshold boundary, and the E2E threshold-override seam.
//
// The hook flips `stalled` from setTimeout callbacks, so every assertion
// flushes pending timers via `flush()` (advance fake time to run the
// 0-delay sync timer) or an explicit threshold advance.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STALLED_THRESHOLD_MS, useStalledSync } from "./useStalledSync";

type Args = Parameters<typeof useStalledSync>[0];

const COLLECTOR = "11111111-1111-4111-8111-111111111111";
const OTHER_COLLECTOR = "22222222-2222-4222-8222-222222222222";
const MARKER_KEY = `safaricash:sync:stalled-since:${COLLECTOR}`;
const E2E_KEY = "safaricash:e2e:stalled-threshold-ms";
const NOW = new Date("2026-05-15T10:00:00.000Z").getTime();

/** Flush the 0-delay sync timer so `stalled` reflects the latest inputs. */
function flush(): void {
  act(() => {
    vi.advanceTimersByTime(0);
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("useStalledSync", () => {
  it("online + non-empty queue + elapsed < threshold → NOT stalled", () => {
    const { result } = renderHook(() =>
      useStalledSync({ online: true, pendingCount: 2, collectorId: COLLECTOR }),
    );
    flush();
    expect(result.current).toBe(false);
    expect(localStorage.getItem(MARKER_KEY)).toBe(String(NOW));
  });

  it("online + non-empty queue + elapsed >= threshold → stalled (reload-durable marker)", () => {
    localStorage.setItem(MARKER_KEY, String(NOW - 20 * 60 * 1000));
    const { result } = renderHook(() =>
      useStalledSync({ online: true, pendingCount: 1, collectorId: COLLECTOR }),
    );
    flush();
    expect(result.current).toBe(true);
  });

  it("offline + non-empty queue + past threshold → NOT stalled (offline is expected)", () => {
    localStorage.setItem(MARKER_KEY, String(NOW - 30 * 60 * 1000));
    const { result } = renderHook(() =>
      useStalledSync({ online: false, pendingCount: 1, collectorId: COLLECTOR }),
    );
    flush();
    expect(result.current).toBe(false);
    // Marker is NOT cleared by going offline (the clock keeps its anchor).
    expect(localStorage.getItem(MARKER_KEY)).toBe(String(NOW - 30 * 60 * 1000));
  });

  it("queue drains (pending > 0 → 0) → NOT stalled + marker cleared", () => {
    const { result, rerender } = renderHook((props: Args) => useStalledSync(props), {
      initialProps: { online: true, pendingCount: 2, collectorId: COLLECTOR } as Args,
    });
    expect(localStorage.getItem(MARKER_KEY)).toBe(String(NOW));
    act(() => {
      rerender({ online: true, pendingCount: 0, collectorId: COLLECTOR });
    });
    flush();
    expect(result.current).toBe(false);
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("initial pendingCount 0 (count not loaded yet) does NOT clear an existing marker", () => {
    localStorage.setItem(MARKER_KEY, String(NOW - 20 * 60 * 1000));
    const { result } = renderHook(() =>
      useStalledSync({ online: true, pendingCount: 0, collectorId: COLLECTOR }),
    );
    flush();
    // pendingCount 0 → not stalled, regardless of the surviving marker.
    expect(result.current).toBe(false);
    expect(localStorage.getItem(MARKER_KEY)).toBe(String(NOW - 20 * 60 * 1000));
  });

  it("the threshold timer flips false → true after the threshold elapses", () => {
    const { result } = renderHook(() =>
      useStalledSync({ online: true, pendingCount: 1, collectorId: COLLECTOR }),
    );
    flush();
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(STALLED_THRESHOLD_MS);
    });
    expect(result.current).toBe(true);
  });

  it("threshold boundary — exactly STALLED_THRESHOLD_MS elapsed → stalled (>=)", () => {
    localStorage.setItem(MARKER_KEY, String(NOW - STALLED_THRESHOLD_MS));
    const { result } = renderHook(() =>
      useStalledSync({ online: true, pendingCount: 1, collectorId: COLLECTOR }),
    );
    flush();
    expect(result.current).toBe(true);
  });

  it("collectorId === null → NOT stalled (no session)", () => {
    const { result } = renderHook(() =>
      useStalledSync({ online: true, pendingCount: 3, collectorId: null }),
    );
    flush();
    expect(result.current).toBe(false);
  });

  it("sign-out (collectorId → null) clears the previous collector's marker", () => {
    const { rerender } = renderHook((props: Args) => useStalledSync(props), {
      initialProps: { online: true, pendingCount: 1, collectorId: COLLECTOR } as Args,
    });
    expect(localStorage.getItem(MARKER_KEY)).toBe(String(NOW));
    act(() => {
      rerender({ online: true, pendingCount: 1, collectorId: null });
    });
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("collector switch clears the outgoing collector's marker", () => {
    const { rerender } = renderHook((props: Args) => useStalledSync(props), {
      initialProps: { online: true, pendingCount: 1, collectorId: COLLECTOR } as Args,
    });
    expect(localStorage.getItem(MARKER_KEY)).toBe(String(NOW));
    act(() => {
      rerender({ online: true, pendingCount: 1, collectorId: OTHER_COLLECTOR });
    });
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
    expect(localStorage.getItem(`safaricash:sync:stalled-since:${OTHER_COLLECTOR}`)).toBe(
      String(NOW),
    );
  });

  it("E2E threshold-override seam — a small localStorage threshold makes it stall fast", () => {
    localStorage.setItem(E2E_KEY, "1000");
    localStorage.setItem(MARKER_KEY, String(NOW - 2000));
    const { result } = renderHook(() =>
      useStalledSync({ online: true, pendingCount: 1, collectorId: COLLECTOR }),
    );
    flush();
    expect(result.current).toBe(true);
  });

  it("going offline does not clear the marker; coming back online re-evaluates", () => {
    localStorage.setItem(MARKER_KEY, String(NOW - 20 * 60 * 1000));
    const { result, rerender } = renderHook((props: Args) => useStalledSync(props), {
      initialProps: { online: true, pendingCount: 1, collectorId: COLLECTOR } as Args,
    });
    flush();
    expect(result.current).toBe(true);
    act(() => {
      rerender({ online: false, pendingCount: 1, collectorId: COLLECTOR });
    });
    flush();
    expect(result.current).toBe(false);
    act(() => {
      rerender({ online: true, pendingCount: 1, collectorId: COLLECTOR });
    });
    flush();
    expect(result.current).toBe(true);
  });
});
