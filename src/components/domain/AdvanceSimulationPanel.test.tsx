// Story 5.1 — AdvanceSimulationPanel component tests.
import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import { AdvanceSimulationPanel } from "./AdvanceSimulationPanel";

expect.extend(toHaveNoViolations);

// 2026-06-19 — cap + final balance derive from the PROJECTED total
// (dailyAmount × cycleLength). dailyAmount 5000 × cycleLength 30 = 150 000.
// 2026-07-28 — commission removed: 3 rows (total / advance / final);
// final = max(0, projected − Σadvances − opening).
describe("AdvanceSimulationPanel", () => {
  it("empty state — candidateAmount=0 shows placeholder, final row dimmed", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[]}
        candidateAmount={0}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "empty");
    expect(screen.getByText(/— FCFA/)).toBeInTheDocument();
  });

  it("valid state — candidate=20_000 → final = 150 000 − 20 000 = 130 000", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[]}
        candidateAmount={20_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    expect(screen.getByText(/150[\s ]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/− 20[\s ]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/130[\s ]000 FCFA/)).toBeInTheDocument();
  });

  it("valid state with existing advances — final = projected − (existing + candidate)", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[10_000]}
        candidateAmount={20_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    // 150 000 − (10 000 + 20 000) = 120 000.
    expect(screen.getByText(/120[\s ]000 FCFA/)).toBeInTheDocument();
  });

  it("boundary — candidate hits exactly the projected cap (150 000) → valid; final = 0", () => {
    // The full projected total (150 000) is borrowable → final = 150 000 −
    // 150 000 = 0.
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[]}
        candidateAmount={150_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    // Match exactly "0 FCFA" (boundary: final row only). Anchors avoid matching
    // "...000 FCFA" suffixes from the other rows.
    expect(screen.getByText(/^0 FCFA$/)).toBeInTheDocument();
  });

  it("over the projected cap by 1 FCFA (150 001) → over-limit", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[]}
        candidateAmount={150_001}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "over-limit");
  });

  it("over-limit — candidate=200_000 → advance row warning + final row = 0 FCFA + explanatory note", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[]}
        candidateAmount={200_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "over-limit");
    expect(screen.getByText(/Dépasse le solde disponible/)).toBeInTheDocument();
    expect(screen.getByText(/Le prêt ne peut pas dépasser le solde projeté\./)).toBeInTheDocument();
    // Match exactly "0 FCFA" (boundary: final row only). Anchors avoid matching
    // "...000 FCFA" suffixes from the other rows.
    expect(screen.getByText(/^0 FCFA$/)).toBeInTheDocument();
  });

  it("aria-live='polite' is on the final-balance container only", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
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
        existingAdvances={[]}
        candidateAmount={10_000}
      />,
    );
    expect(screen.getByText(/− 10[\s ]000 FCFA/)).toBeInTheDocument();
    rerender(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[]}
        candidateAmount={20_000}
      />,
    );
    expect(screen.getByText(/− 20[\s ]000 FCFA/)).toBeInTheDocument();
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
        />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
