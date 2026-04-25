// Story 4.3 — showContributionToast tests.
//
// Verifies the toast is mounted via sonner.toast.custom and that the 1s
// countdown ticks down. Sonner is fully mocked — no real DOM mount.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const customMock = vi.fn(() => "toast-id-1");
const dismissMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    custom: (...args: unknown[]) => customMock(...args),
    dismiss: (...args: unknown[]) => dismissMock(...args),
  },
}));

vi.mock("@/components/domain/ProgressiveToast", () => ({
  ProgressiveToast: vi.fn(() => null),
}));

import { showContributionToast } from "./showContributionToast";

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
});
