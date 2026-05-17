// Story 9.1 — DashboardQuickActions tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { DashboardQuickActions } from "./DashboardQuickActions";

expect.extend(toHaveNoViolations);

function MembersProbe() {
  const [params] = useSearchParams();
  return <div>Liste des membres — intent:{params.get("intent") ?? "none"}</div>;
}

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route path="/dashboard" element={<DashboardQuickActions />} />
        <Route path="/members" element={<MembersProbe />} />
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

  it("Cotisation shortcut → members list with no advance intent", async () => {
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: "Cotisation" }));
    expect(await screen.findByText(/Liste des membres — intent:none/)).toBeInTheDocument();
  });

  it("Prêt Express shortcut → members list carrying intent=advance", async () => {
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: "Prêt Express" }));
    expect(await screen.findByText(/Liste des membres — intent:advance/)).toBeInTheDocument();
  });

  it("axe-clean", async () => {
    const { container } = renderWithRouter();
    expect(await axe(container)).toHaveNoViolations();
  });
});
