// Story 5.4 — showAdvanceToast minimal contract test.
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

import { showAdvanceToast } from "./showAdvanceToast";
import { ProgressiveToast } from "@/components/domain/ProgressiveToast";

describe("showAdvanceToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    customMock.mockClear();
    dismissMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a 'Prêt accordé — {name}' bodyOverride to ProgressiveToast", () => {
    showAdvanceToast({ memberName: "Awa", onUndo: vi.fn() });
    const factory = customMock.mock.calls[0]?.[0] as (id: number) => unknown;
    factory(123);
    const lastCall = vi.mocked(ProgressiveToast).mock.calls.at(-1);
    const props = lastCall?.[0] as { state: { kind: string; bodyOverride?: string } };
    expect(props.state.kind).toBe("just-committed");
    expect(props.state.bodyOverride).toBe("Prêt accordé — Awa");
  });

  it("dismisses the toast at T-0", () => {
    showAdvanceToast({ memberName: "Awa", onUndo: vi.fn() });
    vi.advanceTimersByTime(5000);
    expect(dismissMock).toHaveBeenCalled();
  });
});
