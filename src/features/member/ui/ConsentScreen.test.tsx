// Story 2.3 — ConsentScreen tests.
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { ConsentScreen } from "./ConsentScreen";

expect.extend(toHaveNoViolations);

describe("ConsentScreen", () => {
  it("renders title + body + bullets + checkbox + 2 CTAs", () => {
    render(<ConsentScreen onContinue={vi.fn()} onCancel={vi.fn()} />);
    expect(
      screen.getByRole("heading", { level: 1, name: /importer depuis vos contacts/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/aucune donnée ne quitte votre téléphone/i)).toBeInTheDocument();
    expect(screen.getByText(/nous lisons : nom, numéro/i)).toBeInTheDocument();
    expect(screen.getByText(/nous ne lisons pas : email/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continuer/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /annuler/i })).toBeEnabled();
  });

  it("Continuer becomes enabled only after the checkbox is checked", () => {
    render(<ConsentScreen onContinue={vi.fn()} onCancel={vi.fn()} />);
    const cta = screen.getByRole("button", { name: /continuer/i });
    expect(cta).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(cta).toBeEnabled();
  });

  it("Continuer click invokes onContinue", () => {
    const onContinue = vi.fn();
    render(<ConsentScreen onContinue={onContinue} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /continuer/i }));
    expect(onContinue).toHaveBeenCalled();
  });

  it("Annuler click invokes onCancel without checking the box", () => {
    const onCancel = vi.fn();
    render(<ConsentScreen onContinue={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /annuler/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = render(<ConsentScreen onContinue={vi.fn()} onCancel={vi.fn()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
