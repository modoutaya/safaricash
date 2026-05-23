// 2026-05-23 — MemberFilterSheet unit tests.
//
// The component is pure presentation (parent owns selection state) so
// the tests pin: render → toggle → onToggle dispatch, clear → onClear,
// closing-CTA label tracks resultCount, trigger badge tracks activeCount.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TranslationKey } from "@/i18n/keys";

import {
  MemberFilterSheet,
  MemberFilterTrigger,
  type MemberFilterOption,
} from "./MemberFilterSheet";

// jsdom doesn't implement <dialog>.showModal/close. Same shim as
// TransactionReceiptSheet.test.tsx / SettlementReauthDialog.test.tsx.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

type DemoValue = "actif" | "avance" | "termine";

const OPTIONS: readonly MemberFilterOption<DemoValue>[] = [
  { value: "actif", labelKey: "members.filter_actif" as TranslationKey },
  { value: "avance", labelKey: "members.filter_avance" as TranslationKey },
  { value: "termine", labelKey: "members.filter_termine" as TranslationKey },
];

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof MemberFilterSheet<DemoValue>>> = {},
) {
  const onToggle = vi.fn();
  const onClear = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <MemberFilterSheet<DemoValue>
      open={true}
      onOpenChange={onOpenChange}
      options={OPTIONS}
      selected={new Set<DemoValue>()}
      onToggle={onToggle}
      onClear={onClear}
      resultCount={5}
      {...overrides}
    />,
  );
  return { onToggle, onClear, onOpenChange };
}

describe("MemberFilterSheet", () => {
  it("renders one checkbox per option, unchecked when not selected", () => {
    renderSheet();
    const actif = screen.getByRole("checkbox", { name: "Actif" });
    const avance = screen.getByRole("checkbox", { name: "Avance" });
    const termine = screen.getByRole("checkbox", { name: "Terminé" });
    expect(actif).not.toBeChecked();
    expect(avance).not.toBeChecked();
    expect(termine).not.toBeChecked();
  });

  it("checkboxes reflect the `selected` prop", () => {
    renderSheet({ selected: new Set<DemoValue>(["avance"]) });
    expect(screen.getByRole("checkbox", { name: "Avance" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Actif" })).not.toBeChecked();
  });

  it("toggling a checkbox calls onToggle with the option value", () => {
    const { onToggle } = renderSheet();
    fireEvent.click(screen.getByRole("checkbox", { name: "Avance" }));
    expect(onToggle).toHaveBeenCalledWith("avance");
  });

  it("the closing CTA copy tracks resultCount (zero / singular / plural)", () => {
    const { unmount } = render(
      <MemberFilterSheet<DemoValue>
        open={true}
        onOpenChange={vi.fn()}
        options={OPTIONS}
        selected={new Set<DemoValue>()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
        resultCount={0}
      />,
    );
    expect(screen.getByRole("button", { name: /aucun membre/i })).toBeInTheDocument();
    unmount();

    const { unmount: unmount2 } = render(
      <MemberFilterSheet<DemoValue>
        open={true}
        onOpenChange={vi.fn()}
        options={OPTIONS}
        selected={new Set<DemoValue>()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
        resultCount={1}
      />,
    );
    expect(screen.getByRole("button", { name: /voir 1 membre$/i })).toBeInTheDocument();
    unmount2();

    render(
      <MemberFilterSheet<DemoValue>
        open={true}
        onOpenChange={vi.fn()}
        options={OPTIONS}
        selected={new Set<DemoValue>()}
        onToggle={vi.fn()}
        onClear={vi.fn()}
        resultCount={7}
      />,
    );
    expect(screen.getByRole("button", { name: /voir 7 membres/i })).toBeInTheDocument();
  });

  it("tapping the CTA closes the sheet (onOpenChange(false))", () => {
    const { onOpenChange } = renderSheet({ resultCount: 3 });
    fireEvent.click(screen.getByRole("button", { name: /voir 3 membres/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Effacer button is disabled when no chip is selected", () => {
    renderSheet({ selected: new Set<DemoValue>() });
    expect(screen.getByRole("button", { name: /effacer/i })).toBeDisabled();
  });

  it("Effacer button calls onClear when a chip is selected", () => {
    const { onClear } = renderSheet({ selected: new Set<DemoValue>(["actif"]) });
    fireEvent.click(screen.getByRole("button", { name: /effacer/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("MemberFilterTrigger", () => {
  it("shows the label without a badge when no filter is active", () => {
    render(<MemberFilterTrigger onClick={vi.fn()} activeCount={0} />);
    const trigger = screen.getByRole("button", { name: /^Filtres/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("data-active-filter-count", "0");
    expect(screen.queryByText(/filtre.* actif/i)).not.toBeInTheDocument();
  });

  it("shows a numeric badge with aria-label when filters are active", () => {
    render(<MemberFilterTrigger onClick={vi.fn()} activeCount={2} />);
    const trigger = screen.getByRole("button", { name: /^Filtres/i });
    expect(trigger).toHaveAttribute("data-active-filter-count", "2");
    expect(screen.getByLabelText(/2 filtre/i)).toBeInTheDocument();
  });

  it("fires onClick when tapped", () => {
    const onClick = vi.fn();
    render(<MemberFilterTrigger onClick={onClick} activeCount={0} />);
    fireEvent.click(screen.getByRole("button", { name: /^Filtres/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
