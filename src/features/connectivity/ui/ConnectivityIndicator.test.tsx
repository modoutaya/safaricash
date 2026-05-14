// Story 8.1 — ConnectivityIndicator component tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { ConnectivityIndicator } from "./ConnectivityIndicator";

expect.extend(toHaveNoViolations);

describe("ConnectivityIndicator", () => {
  it("connected state — renders Wifi icon + 'En ligne' label + primary palette", () => {
    const { container } = render(
      <ConnectivityIndicator state="connected" pendingCount={0} onTap={vi.fn()} />,
    );
    // Label visible.
    expect(screen.getByText("En ligne")).toBeInTheDocument();
    // Visual pill has the primary-100 background.
    const pill = container.querySelector(".rounded-full");
    expect(pill?.className).toMatch(/bg-primary-100/);
    expect(pill?.className).toMatch(/text-primary-700/);
    // No bullet/count suffix for the connected state.
    expect(screen.queryByText(/•/)).not.toBeInTheDocument();
    // No animate-spin / animate-pulse classes.
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("syncing state — Loader2 spinning + 'Synchronisation • 3' + warning palette", () => {
    const { container } = render(
      <ConnectivityIndicator state="syncing" pendingCount={3} onTap={vi.fn()} />,
    );
    expect(screen.getByText("Synchronisation • 3")).toBeInTheDocument();
    const pill = container.querySelector(".rounded-full");
    expect(pill?.className).toMatch(/bg-warning-bg/);
    expect(pill?.className).toMatch(/text-warning/);
    // The Loader2 icon has animate-spin.
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    // No pulse on the syncing state.
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("offline state — WifiOff + 'Hors-ligne • 2' + neutral palette", () => {
    const { container } = render(
      <ConnectivityIndicator state="offline" pendingCount={2} onTap={vi.fn()} />,
    );
    expect(screen.getByText("Hors-ligne • 2")).toBeInTheDocument();
    const pill = container.querySelector(".rounded-full");
    expect(pill?.className).toMatch(/bg-neutral-100/);
    expect(pill?.className).toMatch(/text-text-secondary/);
  });

  it("sync-failed state — AlertTriangle + 'Erreur • 1' + warning palette + animate-pulse on icon ONLY", () => {
    const { container } = render(
      <ConnectivityIndicator state="sync-failed" pendingCount={1} onTap={vi.fn()} />,
    );
    expect(screen.getByText("Erreur • 1")).toBeInTheDocument();
    const pill = container.querySelector(".rounded-full");
    expect(pill?.className).toMatch(/bg-warning-bg/);
    // animate-pulse is on the icon, not the pill.
    const pulsingIcon = container.querySelector(".animate-pulse");
    expect(pulsingIcon).not.toBeNull();
    // The icon is an SVG, not the pill span.
    expect(pulsingIcon?.tagName.toLowerCase()).toBe("svg");
    // Confirm the pill itself doesn't pulse (UX-DR5 — never red-alarm; the
    // pulse is restricted to the icon).
    expect(pill?.className).not.toMatch(/animate-pulse/);
  });

  it("offline with pendingCount=0 — bare 'Hors-ligne' label (no bullet/count)", () => {
    render(<ConnectivityIndicator state="offline" pendingCount={0} onTap={vi.fn()} />);
    expect(screen.getByText("Hors-ligne")).toBeInTheDocument();
    expect(screen.queryByText(/Hors-ligne •/)).not.toBeInTheDocument();
  });

  it("syncing with pendingCount=0 — bare 'Synchronisation' (defensive — practically unreachable)", () => {
    render(<ConnectivityIndicator state="syncing" pendingCount={0} onTap={vi.fn()} />);
    expect(screen.getByText("Synchronisation")).toBeInTheDocument();
    expect(screen.queryByText(/Synchronisation •/)).not.toBeInTheDocument();
  });

  it("sync-failed with pendingCount=0 — bare 'Erreur' (defensive — practically unreachable)", () => {
    render(<ConnectivityIndicator state="sync-failed" pendingCount={0} onTap={vi.fn()} />);
    expect(screen.getByText("Erreur")).toBeInTheDocument();
    expect(screen.queryByText(/Erreur •/)).not.toBeInTheDocument();
  });

  it("aria-live='polite' is on the visible label span (single live region per pill)", () => {
    const { container } = render(
      <ConnectivityIndicator state="connected" pendingCount={0} onTap={vi.fn()} />,
    );
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.className).toMatch(/rounded-full/);
  });

  it("aria-label on the wrapping button contains the state context", () => {
    render(<ConnectivityIndicator state="offline" pendingCount={5} onTap={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-label");
    expect(btn.getAttribute("aria-label")).toMatch(/Statut de connexion/);
    expect(btn.getAttribute("aria-label")).toMatch(/Hors-ligne • 5/);
  });

  it("clicking the pill calls onTap once", () => {
    const onTap = vi.fn();
    render(<ConnectivityIndicator state="connected" pendingCount={0} onTap={onTap} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("wrapping button has py-2 for 40px hit-area (AC #13 trade-off)", () => {
    // Code-review patch #6 — pin the hit-area class. AC #13 documents 40px
    // as an accepted trade-off vs. UX's 44px floor; without this assertion
    // a future restyling could silently drop py-2 and shrink the target.
    const { container } = render(
      <ConnectivityIndicator state="connected" pendingCount={0} onTap={vi.fn()} />,
    );
    const btn = container.querySelector("button");
    expect(btn?.className).toMatch(/py-2/);
  });

  it("axe-clean across all 4 states", async () => {
    const states: Array<{
      state: "connected" | "syncing" | "offline" | "sync-failed";
      pendingCount: number;
    }> = [
      { state: "connected", pendingCount: 0 },
      { state: "syncing", pendingCount: 2 },
      { state: "offline", pendingCount: 3 },
      { state: "sync-failed", pendingCount: 1 },
    ];
    for (const c of states) {
      const { container, unmount } = render(
        <ConnectivityIndicator state={c.state} pendingCount={c.pendingCount} onTap={vi.fn()} />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
