import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "./StatusBadge";

expect.extend(toHaveNoViolations);

describe("StatusBadge", () => {
  it("renders the French label for 'actif'", () => {
    render(<StatusBadge kind="actif" />);
    expect(screen.getByText("Actif")).toBeInTheDocument();
  });

  it("renders the French label for 'avance'", () => {
    render(<StatusBadge kind="avance" />);
    expect(screen.getByText("Avance")).toBeInTheDocument();
  });

  it("exposes data-status for deterministic selection", () => {
    render(<StatusBadge kind="avance" />);
    expect(screen.getByText("Avance").closest("[data-status]")).toHaveAttribute(
      "data-status",
      "avance",
    );
  });

  it("applies a distinct token class bundle per kind (color + label, never color-alone)", () => {
    const { rerender } = render(<StatusBadge kind="actif" />);
    const actifClasses = screen.getByText("Actif").className;

    rerender(<StatusBadge kind="avance" />);
    const avanceClasses = screen.getByText("Avance").className;

    expect(actifClasses).not.toBe(avanceClasses);
  });

  it("passes axe a11y checks for both kinds", async () => {
    for (const kind of ["actif", "avance"] as const) {
      const { container, unmount } = render(<StatusBadge kind={kind} />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
