// Story 9.1 — DashboardHero tests.

import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import { DashboardHero } from "./DashboardHero";

expect.extend(toHaveNoViolations);

describe("DashboardHero", () => {
  it("renders the greeting, subtitle and the three stats", () => {
    render(
      <DashboardHero activeMembersCount={5} todayCollected={9000} commissionThisCycle={1500} />,
    );
    expect(screen.getByRole("heading", { name: "Bonjour Collecteur" })).toBeInTheDocument();
    expect(screen.getByText("Votre activité aujourd'hui")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Membres actifs")).toBeInTheDocument();
  });

  it("axe-clean", async () => {
    const { container } = render(
      <DashboardHero activeMembersCount={0} todayCollected={0} commissionThisCycle={0} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
