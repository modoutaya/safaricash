// Story 8.3 — showOfflineToast unit tests.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const toastCustomMock = vi.fn().mockReturnValue("toast-id");
const toastDismissMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    custom: (...args: unknown[]) => toastCustomMock(...args),
    dismiss: (id: unknown) => toastDismissMock(id),
  },
}));

import { showOfflineToast } from "./showOfflineToast";

describe("showOfflineToast", () => {
  it("mounts a custom sonner toast with a 4-second finite duration", () => {
    toastCustomMock.mockClear();
    showOfflineToast({ memberName: "Aïssatou" });
    expect(toastCustomMock).toHaveBeenCalledTimes(1);
    const opts = toastCustomMock.mock.calls[0]?.[1];
    expect(opts).toMatchObject({ duration: 4_000 });
  });

  it("renders the offline copy + member name when the toast factory fires", () => {
    toastCustomMock.mockClear();
    showOfflineToast({ memberName: "Aïssatou" });
    const factory = toastCustomMock.mock.calls[0]?.[0] as (id: number) => React.ReactElement;
    render(factory(42));
    // The ProgressiveToast resolves members.toast.offline →
    // "Hors-ligne — envoi au prochain réseau" (fr.json:260).
    expect(screen.getByText(/Hors-ligne/i)).toBeInTheDocument();
  });
});
