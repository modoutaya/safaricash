// Story 8.1 — ConnectivitySyncDrawer skeleton tests.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectivitySyncDrawer } from "./ConnectivitySyncDrawer";

expect.extend(toHaveNoViolations);

beforeEach(() => {
  // jsdom doesn't ship <dialog>'s show/close — same shim as Stories 6.6 / 7.4.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

describe("ConnectivitySyncDrawer", () => {
  it("open=true renders the title + close button", () => {
    render(<ConnectivitySyncDrawer open onOpenChange={vi.fn()} pendingCount={0} />);
    expect(screen.getByRole("heading", { level: 2, name: /Synchronisation/ })).toBeInTheDocument();
    // Two close affordances: the X icon button + the outline Button.
    expect(screen.getAllByRole("button", { name: /Fermer/ })).toHaveLength(2);
  });

  it("pendingCount === 0 renders the empty-state message", () => {
    render(<ConnectivitySyncDrawer open onOpenChange={vi.fn()} pendingCount={0} />);
    expect(screen.getByText("Aucune opération en attente.")).toBeInTheDocument();
    expect(screen.queryByText(/Le détail arrivera/)).not.toBeInTheDocument();
  });

  it("pendingCount > 0 renders the placeholder count message", () => {
    render(<ConnectivitySyncDrawer open onOpenChange={vi.fn()} pendingCount={5} />);
    expect(
      screen.getByText("5 opérations en attente. Le détail arrivera bientôt."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Aucune opération en attente/)).not.toBeInTheDocument();
  });

  it("close button (X icon) fires onOpenChange(false) exactly once", () => {
    const onOpenChange = vi.fn();
    render(<ConnectivitySyncDrawer open onOpenChange={onOpenChange} pendingCount={0} />);
    // The first 'Fermer' is the X icon button; the second is the outline Button.
    fireEvent.click(screen.getAllByRole("button", { name: /Fermer/ })[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Code-review patch #4 — pin the call count to catch any future
    // double-invocation regression (the native <dialog> onClose handler
    // could fire a second time in an integration scenario).
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("outline close Button also fires onOpenChange(false) exactly once", () => {
    const onOpenChange = vi.fn();
    render(<ConnectivitySyncDrawer open onOpenChange={onOpenChange} pendingCount={0} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Fermer/ })[1]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("focus lands on the X close button after mount (programmatic, not autoFocus)", async () => {
    render(<ConnectivitySyncDrawer open onOpenChange={vi.fn()} pendingCount={0} />);
    // The X close button is the first 'Fermer' (icon-only), focused via the
    // useEffect after mount.
    const xButton = screen.getAllByRole("button", { name: /Fermer/ })[0]!;
    await waitFor(() => expect(document.activeElement).toBe(xButton));
  });

  it("axe-clean across empty + populated states", async () => {
    for (const c of [{ pendingCount: 0 }, { pendingCount: 3 }]) {
      const { container, unmount } = render(
        <ConnectivitySyncDrawer open onOpenChange={vi.fn()} pendingCount={c.pendingCount} />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
