// Story 9.1 — DashboardStatCards tests.
// 2026-05-24 — Collecté is masked by default and toggles on tap.
// Active-members count stays static.
// 2026-07-28 — Commission tile removed (commission dropped).

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import { DashboardStatCards } from "./DashboardStatCards";

expect.extend(toHaveNoViolations);

describe("DashboardStatCards", () => {
  it("renders the labels with active-members count visible and the money value masked", () => {
    render(<DashboardStatCards activeMembersCount={7} cycleCollected={12500} />);
    // Labels visible for both tiles.
    expect(screen.getByText("Membres actifs")).toBeInTheDocument();
    expect(screen.getByText("Collecté")).toBeInTheDocument();
    // Active-members value is plain text (not masked).
    expect(screen.getByText("7")).toBeInTheDocument();
    // Money value is masked by default — the actual figure doesn't render.
    expect(screen.queryByText(/12\s?500/)).not.toBeInTheDocument();
    // One masked tile, showing the asterisk placeholder.
    expect(screen.getAllByText("*******")).toHaveLength(1);
  });

  it("tapping the Collecté tile reveals its value; tapping again re-masks it", () => {
    render(<DashboardStatCards activeMembersCount={1} cycleCollected={12500} />);
    const collectedToggle = screen.getByRole("button", { name: "Afficher le montant collecté" });
    expect(collectedToggle).toHaveAttribute("aria-pressed", "false");

    // Reveal.
    fireEvent.click(collectedToggle);
    expect(screen.getByText(/12\s?500/)).toBeInTheDocument();
    // Tile is now in revealed state — aria-label flips, aria-pressed=true,
    // and no mask remains.
    expect(screen.getByRole("button", { name: "Masquer le montant collecté" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText("*******")).not.toBeInTheDocument();

    // Re-hide.
    fireEvent.click(screen.getByRole("button", { name: "Masquer le montant collecté" }));
    expect(screen.queryByText(/12\s?500/)).not.toBeInTheDocument();
    expect(screen.getAllByText("*******")).toHaveLength(1);
  });

  it("axe-clean in the default (masked) state", async () => {
    const { container } = render(<DashboardStatCards activeMembersCount={0} cycleCollected={0} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("axe-clean after revealing the money tile", async () => {
    const { container } = render(
      <DashboardStatCards activeMembersCount={0} cycleCollected={500} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Afficher le montant collecté" }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
