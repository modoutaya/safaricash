// Story 12.1 — period selector UI behaviour.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { JournalPeriodSelector } from "./JournalPeriodSelector";

describe("JournalPeriodSelector", () => {
  it("renders three options and marks the active one via aria-checked", () => {
    render(<JournalPeriodSelector value="cycle_previous" onChange={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Cycle précédent" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Cycle en cours" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("radio", { name: "2 derniers jours" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("fires onChange with the selected period when a non-active option is tapped", () => {
    const onChange = vi.fn();
    render(<JournalPeriodSelector value="cycle_previous" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "2 derniers jours" }));
    expect(onChange).toHaveBeenCalledWith("last_two_days");
  });

  it("group has the radiogroup role + accessible label", () => {
    render(<JournalPeriodSelector value="cycle_current" onChange={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Période affichée" })).toBeInTheDocument();
  });
});
