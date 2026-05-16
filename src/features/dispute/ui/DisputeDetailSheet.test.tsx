// Story 10.3 — DisputeDetailSheet tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DisputeDetailSheet } from "./DisputeDetailSheet";
import type { DisputeRow } from "../types";

expect.extend(toHaveNoViolations);

const DISPUTE: DisputeRow = {
  id: "d0000000-0000-4000-8000-000000000001",
  transaction_id: "a0000000-0000-4000-8000-000000000001",
  notes: "Je n'ai jamais reçu cet argent",
  flagged_at: "2026-05-10T09:30:00.000Z",
  status: "open",
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function renderSheet(overrides: Partial<Parameters<typeof DisputeDetailSheet>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onResolve = vi.fn();
  const utils = render(
    <DisputeDetailSheet
      open
      onOpenChange={onOpenChange}
      dispute={DISPUTE}
      onResolve={onResolve}
      isResolving={false}
      {...overrides}
    />,
  );
  return { ...utils, onOpenChange, onResolve };
}

describe("DisputeDetailSheet", () => {
  it("renders the saver message + the flagged-at date", () => {
    renderSheet();
    expect(screen.getByText("Je n'ai jamais reçu cet argent")).toBeInTheDocument();
    expect(screen.getByText("Détail de la contestation")).toBeInTheDocument();
    // 2026-05-10 → DD/MM/YYYY in the rendered date row.
    expect(screen.getByText(/10\/05\/2026/)).toBeInTheDocument();
  });

  it("shows the empty-message placeholder when notes is null", () => {
    renderSheet({ dispute: { ...DISPUTE, notes: null } });
    expect(screen.getByText("Aucun message")).toBeInTheDocument();
  });

  it("tapping 'Marquer comme résolue' calls onResolve", () => {
    const { onResolve } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /marquer comme résolue/i }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("disables the resolve button + shows the in-progress label while resolving", () => {
    renderSheet({ isResolving: true });
    const btn = screen.getByRole("button", { name: /résolution/i });
    expect(btn).toBeDisabled();
  });

  it("is axe-clean", async () => {
    const { container } = renderSheet();
    expect(await axe(container)).toHaveNoViolations();
  });
});
