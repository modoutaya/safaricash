// Story 9.1 — DashboardStatCards tests.
// 2026-05-24 — Collecté + Commission are masked by default and toggle
// individually on tap. Active-members count stays static.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import { DashboardStatCards } from "./DashboardStatCards";

expect.extend(toHaveNoViolations);

describe("DashboardStatCards", () => {
  it("renders the three labels with active-members count visible and money values masked", () => {
    render(
      <DashboardStatCards
        activeMembersCount={7}
        cycleCollected={12500}
        commissionThisCycle={3000}
      />,
    );
    // Labels visible for all three.
    expect(screen.getByText("Membres actifs")).toBeInTheDocument();
    expect(screen.getByText("Collecté")).toBeInTheDocument();
    expect(screen.getByText("Commission")).toBeInTheDocument();
    // Active-members value is plain text (not masked).
    expect(screen.getByText("7")).toBeInTheDocument();
    // Money values are masked by default — the actual figures don't render.
    expect(screen.queryByText(/12\s?500/)).not.toBeInTheDocument();
    expect(screen.queryByText(/3\s?000/)).not.toBeInTheDocument();
    // Two masked tiles, each showing the asterisk placeholder.
    expect(screen.getAllByText("*******")).toHaveLength(2);
  });

  it("tapping the Collecté tile reveals its value; tapping again re-masks it; the Commission tile stays masked", () => {
    render(
      <DashboardStatCards
        activeMembersCount={1}
        cycleCollected={12500}
        commissionThisCycle={3000}
      />,
    );
    const collectedToggle = screen.getByRole("button", { name: "Afficher le montant collecté" });
    expect(collectedToggle).toHaveAttribute("aria-pressed", "false");

    // Reveal.
    fireEvent.click(collectedToggle);
    expect(screen.getByText(/12\s?500/)).toBeInTheDocument();
    // Tile is now in revealed state — aria-label flips, aria-pressed=true,
    // and exactly one mask remains (Commission).
    expect(screen.getByRole("button", { name: "Masquer le montant collecté" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getAllByText("*******")).toHaveLength(1);

    // Re-hide.
    fireEvent.click(screen.getByRole("button", { name: "Masquer le montant collecté" }));
    expect(screen.queryByText(/12\s?500/)).not.toBeInTheDocument();
    expect(screen.getAllByText("*******")).toHaveLength(2);
  });

  it("the Commission tile toggles independently of Collecté", () => {
    render(
      <DashboardStatCards
        activeMembersCount={1}
        cycleCollected={12500}
        commissionThisCycle={3000}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Afficher la commission" }));
    expect(screen.getByText(/3\s?000/)).toBeInTheDocument();
    // Collecté stayed masked.
    expect(screen.queryByText(/12\s?500/)).not.toBeInTheDocument();
    expect(screen.getAllByText("*******")).toHaveLength(1);
  });

  it("axe-clean in the default (masked) state", async () => {
    const { container } = render(
      <DashboardStatCards activeMembersCount={0} cycleCollected={0} commissionThisCycle={0} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("axe-clean after revealing both money tiles", async () => {
    const { container } = render(
      <DashboardStatCards activeMembersCount={0} cycleCollected={500} commissionThisCycle={500} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Afficher le montant collecté" }));
    fireEvent.click(screen.getByRole("button", { name: "Afficher la commission" }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
