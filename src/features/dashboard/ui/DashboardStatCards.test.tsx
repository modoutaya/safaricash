// Story 9.1 — DashboardStatCards tests.

import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import { DashboardStatCards } from "./DashboardStatCards";

expect.extend(toHaveNoViolations);

describe("DashboardStatCards", () => {
  it("renders the three labelled stats with the active-members count", () => {
    render(
      <DashboardStatCards
        activeMembersCount={7}
        todayCollected={12500}
        commissionThisCycle={3000}
      />,
    );
    expect(screen.getByText("Membres actifs")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Collecté")).toBeInTheDocument();
    expect(screen.getByText("Commission")).toBeInTheDocument();
    // The FCFA-formatted money figures (group separators may be NBSP).
    expect(screen.getByText(/12\s?500/)).toBeInTheDocument();
    expect(screen.getByText(/3\s?000/)).toBeInTheDocument();
  });

  it("axe-clean", async () => {
    const { container } = render(
      <DashboardStatCards activeMembersCount={0} todayCollected={0} commissionThisCycle={0} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
