// Story 9.1 — DashboardQuickActions tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { DashboardQuickActions } from "./DashboardQuickActions";

expect.extend(toHaveNoViolations);

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route path="/dashboard" element={<DashboardQuickActions />} />
        <Route path="/members" element={<div>Liste des membres</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DashboardQuickActions", () => {
  it("renders the two shortcut buttons", () => {
    renderWithRouter();
    expect(screen.getByRole("button", { name: "Cotisation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prêt Express" })).toBeInTheDocument();
  });

  it("navigates to the members list from the Cotisation shortcut", async () => {
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: "Cotisation" }));
    expect(await screen.findByText("Liste des membres")).toBeInTheDocument();
  });

  it("navigates to the members list from the Prêt Express shortcut", async () => {
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: "Prêt Express" }));
    expect(await screen.findByText("Liste des membres")).toBeInTheDocument();
  });

  it("axe-clean", async () => {
    const { container } = renderWithRouter();
    expect(await axe(container)).toHaveNoViolations();
  });
});
