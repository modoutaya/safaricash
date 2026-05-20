// BottomNav tests.

import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { BottomNav } from "./BottomNav";

expect.extend(toHaveNoViolations);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BottomNav />
    </MemoryRouter>,
  );
}

describe("BottomNav", () => {
  it("renders the four tabs pointing at their routes", () => {
    renderAt("/dashboard");
    expect(screen.getByRole("link", { name: "Accueil" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: "Membres" })).toHaveAttribute("href", "/members");
    expect(screen.getByRole("link", { name: "Journal" })).toHaveAttribute("href", "/journal");
    expect(screen.getByRole("link", { name: "Plus" })).toHaveAttribute("href", "/settings");
  });

  it("marks the active route's tab with aria-current", () => {
    renderAt("/members");
    expect(screen.getByRole("link", { name: "Membres" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Accueil" })).not.toHaveAttribute("aria-current");
  });

  it("axe-clean", async () => {
    const { container } = renderAt("/dashboard");
    expect(await axe(container)).toHaveNoViolations();
  });
});
