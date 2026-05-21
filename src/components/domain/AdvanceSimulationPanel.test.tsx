// Story 5.1 — AdvanceSimulationPanel component tests.
import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import { AdvanceSimulationPanel } from "./AdvanceSimulationPanel";

expect.extend(toHaveNoViolations);

describe("AdvanceSimulationPanel", () => {
  it("empty state — candidateAmount=0 shows placeholder, row 4 dimmed", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        contributedTotal={145_000}
        existingAdvances={[]}
        candidateAmount={0}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "empty");
    expect(screen.getByText(/— FCFA/)).toBeInTheDocument();
  });

  it("valid state — dailyAmount=5000, no existing, candidate=20_000 → final balance = 120 000 (Story 12.5 PR C)", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        contributedTotal={145_000}
        existingAdvances={[]}
        candidateAmount={20_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    expect(screen.getByText(/150[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/− 5[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/− 20[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/120[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("valid state with existing advances — final = dailyAmount × contributionDays − (existing + candidate)", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        contributedTotal={145_000}
        existingAdvances={[10_000]}
        candidateAmount={20_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    expect(screen.getByText(/110[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("boundary — candidate hits exactly capacity (dailyAmount × contributionDays = 5000 × 29 = 145 000 for cycleLength=30) → final = 0; state=valid", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        contributedTotal={145_000}
        existingAdvances={[]}
        candidateAmount={145_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    // Match exactly "0 FCFA" (boundary: row 4 only). The leading whitespace
    // ensures we don't match "...000 FCFA" suffixes from the other rows.
    expect(screen.getByText(/^0 FCFA$/)).toBeInTheDocument();
  });

  it("over-limit — candidate=200_000 → row 3 warning + row 4 = 0 FCFA + explanatory note", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        contributedTotal={145_000}
        existingAdvances={[]}
        candidateAmount={200_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "over-limit");
    expect(screen.getByText(/Dépasse le solde disponible/)).toBeInTheDocument();
    expect(screen.getByText(/Le prêt ne peut pas dépasser le solde projeté\./)).toBeInTheDocument();
    // Match exactly "0 FCFA" (boundary: row 4 only). The leading whitespace
    // ensures we don't match "...000 FCFA" suffixes from the other rows.
    expect(screen.getByText(/^0 FCFA$/)).toBeInTheDocument();
  });

  it("aria-live='polite' is on the final-balance container only", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        contributedTotal={145_000}
        existingAdvances={[]}
        candidateAmount={20_000}
      />,
    );
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.textContent).toMatch(/Solde final projeté/);
  });

  it("re-renders correctly when candidateAmount changes", () => {
    const { rerender } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        contributedTotal={145_000}
        existingAdvances={[]}
        candidateAmount={10_000}
      />,
    );
    expect(screen.getByText(/− 10[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    rerender(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        contributedTotal={145_000}
        existingAdvances={[]}
        candidateAmount={20_000}
      />,
    );
    expect(screen.getByText(/− 20[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("axe-clean across the 3 distinct states", async () => {
    const dailyAmount = 5000;
    const cases = [
      { existingAdvances: [] as ReadonlyArray<number>, candidateAmount: 0 },
      { existingAdvances: [], candidateAmount: 20_000 },
      { existingAdvances: [], candidateAmount: 200_000 },
    ];
    for (const c of cases) {
      const { container, unmount } = render(
        <AdvanceSimulationPanel
          dailyAmount={dailyAmount}
          existingAdvances={c.existingAdvances}
          candidateAmount={c.candidateAmount}
          cycleLength={30}
          contributedTotal={145_000}
        />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
