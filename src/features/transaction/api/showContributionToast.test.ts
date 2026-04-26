// Story 4.3 — showContributionToast tests.
//
// Verifies the toast is mounted via sonner.toast.custom and that the 1s
// countdown ticks down. Sonner is fully mocked — no real DOM mount.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const customMock = vi.fn<(jsx: unknown, opts?: unknown) => string>(() => "toast-id-1");
const dismissMock = vi.fn<(id: unknown) => void>();

vi.mock("sonner", () => ({
  toast: {
    custom: (jsx: unknown, opts?: unknown) => customMock(jsx, opts),
    dismiss: (id: unknown) => dismissMock(id),
  },
}));

vi.mock("@/components/domain/ProgressiveToast", () => ({
  ProgressiveToast: vi.fn(() => null),
}));

import { showContributionToast, showRattrapageToast } from "./showContributionToast";

import { ProgressiveToast } from "@/components/domain/ProgressiveToast";

describe("showContributionToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    customMock.mockClear();
    dismissMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts a custom toast immediately", () => {
    showContributionToast({ memberName: "Awa", onUndo: vi.fn() });
    expect(customMock).toHaveBeenCalledTimes(1);
  });

  it("re-renders the toast each second of the countdown", () => {
    showContributionToast({ memberName: "Awa", onUndo: vi.fn() });
    expect(customMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(customMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(customMock).toHaveBeenCalledTimes(3);
  });

  it("dismisses the toast at T-0", () => {
    showContributionToast({ memberName: "Awa", onUndo: vi.fn() });
    // 5 seconds = 5 ticks; the 5th brings secondsLeft to 0 → dismiss.
    vi.advanceTimersByTime(5000);
    expect(dismissMock).toHaveBeenCalled();
  });

  describe("showRattrapageToast (Story 4.4)", () => {
    it("passes a rattrapage bodyOverride to ProgressiveToast", () => {
      showRattrapageToast({ memberName: "Awa", daysCovered: 3, onUndo: vi.fn() });
      // Inspect the JSX factory passed to toast.custom — it returns the
      // ProgressiveToast call. Reach the rendered call's first arg.
      const factory = customMock.mock.calls[0]?.[0] as (id: number) => unknown;
      factory(123);
      const lastCall = vi.mocked(ProgressiveToast).mock.calls.at(-1);
      const props = lastCall?.[0] as { state: { bodyOverride?: string; kind: string } };
      expect(props.state.kind).toBe("just-committed");
      expect(props.state.bodyOverride).toBe("Rattrapage enregistré (3 jours) — Awa");
    });

    it("dismisses at T-0 (same lifecycle as contribution)", () => {
      showRattrapageToast({ memberName: "Awa", daysCovered: 2, onUndo: vi.fn() });
      vi.advanceTimersByTime(5000);
      expect(dismissMock).toHaveBeenCalled();
    });
  });
});
