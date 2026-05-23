// Story 12.1 — period selector UI behaviour.
// 2026-05-23 — selector was rewritten as a trigger + bottom-sheet
// (same pattern as MemberFilterSheet). Tests open the sheet first
// then interact with the radio options inside.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JournalPeriodSelector } from "./JournalPeriodSelector";

// jsdom doesn't implement <dialog>.showModal/close. Same shim as
// MemberFilterSheet.test.tsx / TransactionReceiptSheet.test.tsx.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

describe("JournalPeriodSelector", () => {
  it("trigger shows the currently-selected period label inline", () => {
    render(<JournalPeriodSelector value="cycle_previous" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /^Filtres/i });
    expect(trigger).toHaveTextContent("Filtres");
    expect(trigger).toHaveTextContent("Cycle précédent");
    expect(trigger).toHaveAttribute("data-active-period", "cycle_previous");
  });

  it("tapping the trigger opens the sheet with three radio options + active aria-checked", () => {
    render(<JournalPeriodSelector value="cycle_previous" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Filtres/i }));
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Cycle précédent" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Cycle en cours" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "7 derniers jours" })).not.toBeChecked();
  });

  it("fires onChange with the selected period when a non-active radio is tapped", () => {
    const onChange = vi.fn();
    render(<JournalPeriodSelector value="cycle_previous" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /^Filtres/i }));
    fireEvent.click(screen.getByRole("radio", { name: "7 derniers jours" }));
    expect(onChange).toHaveBeenCalledWith("last_seven_days");
  });

  it("radio-group inside the sheet has the radiogroup role + accessible label", () => {
    render(<JournalPeriodSelector value="cycle_current" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Filtres/i }));
    expect(screen.getByRole("radiogroup", { name: "Période affichée" })).toBeInTheDocument();
  });
});
