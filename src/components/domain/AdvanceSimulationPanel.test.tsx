// Story 5.1 — AdvanceSimulationPanel component tests.
import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import { AdvanceSimulationPanel } from "./AdvanceSimulationPanel";

expect.extend(toHaveNoViolations);

// 2026-06-19 — cap + final balance derive from the PROJECTED total
// (dailyAmount × cycleLength). dailyAmount 5000 × cycleLength 30 = 150 000;
// commission (one day) = 5 000.
describe("AdvanceSimulationPanel", () => {
  it("empty state — candidateAmount=0 shows placeholder, row 4 dimmed", () => {
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

  it("valid state — candidate=20_000 → final = 150 000 − 5 000 − 20 000 = 125 000", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[]}
        candidateAmount={20_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    expect(screen.getByText(/150[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/− 5[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/− 20[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/125[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("valid state with existing advances — final = projected − commission − (existing + candidate)", () => {
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[10_000]}
        candidateAmount={20_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    // 150 000 − 5 000 − (10 000 + 20 000) = 115 000.
    expect(screen.getByText(/115[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("boundary — candidate hits exactly the projected cap (150 000) → valid; final clamps to 0", () => {
    // 2026-06-19 — commission is NOT reserved, so the full projected total
    // (150 000) is borrowable. The final balance goes to −5 000 (the unpaid
    // commission) and is clamped to 0 for display.
    const { container } = render(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
        existingAdvances={[]}
        candidateAmount={150_000}
      />,
    );
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "valid");
    // Match exactly "0 FCFA" (boundary: row 4 only). Anchors avoid matching
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

  it("over-limit — candidate=200_000 → row 3 warning + row 4 = 0 FCFA + explanatory note", () => {
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
    // Match exactly "0 FCFA" (boundary: row 4 only). Anchors avoid matching
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
    expect(screen.getByText(/− 10[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    rerender(
      <AdvanceSimulationPanel
        dailyAmount={5000}
        cycleLength={30}
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
        />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
