// Story 2.3 — ContactsPickerStep tests.
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { ContactsPickerStep, type PickedContact } from "./ContactsPickerStep";

expect.extend(toHaveNoViolations);

const CONTACTS: PickedContact[] = [
  { id: "1", name: "Awa Diallo", phone: "+221777915898" },
  { id: "2", name: "Bah Sow", phone: "" },
  { id: "3", name: "Cheikh Ndiaye", phone: "+221770000000" },
];

function renderStep(overrides: Partial<{ contacts: PickedContact[] }> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ContactsPickerStep
      contacts={overrides.contacts ?? CONTACTS}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { ...utils, onConfirm, onCancel };
}

describe("ContactsPickerStep", () => {
  it("renders one row per contact + the bottom confirm CTA disabled by default", () => {
    renderStep();
    expect(screen.getByText("Awa Diallo")).toBeInTheDocument();
    expect(screen.getByText("Bah Sow")).toBeInTheDocument();
    expect(screen.getByText("Cheikh Ndiaye")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirmer l'import \(3\)/i })).toBeDisabled();
  });

  it('"Appliquer à tous" copies the first row\'s amount to every other row', () => {
    renderStep();
    const inputs = screen.getAllByLabelText("Cotisation (FCFA)") as HTMLInputElement[];
    fireEvent.change(inputs[0]!, { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: /appliquer à tous/i }));
    expect(inputs[0]!.value).toBe("500");
    expect(inputs[1]!.value).toBe("500");
    expect(inputs[2]!.value).toBe("500");
  });

  it("removing a row hides it + drops it from the confirm payload", () => {
    const { onConfirm } = renderStep();
    const removeButtons = screen.getAllByRole("button", { name: /retirer ce contact/i });
    fireEvent.click(removeButtons[1]!); // remove Bah Sow
    expect(screen.queryByText("Bah Sow")).not.toBeInTheDocument();

    const inputs = screen.getAllByLabelText("Cotisation (FCFA)");
    fireEvent.change(inputs[0]!, { target: { value: "500" } });
    fireEvent.change(inputs[1]!, { target: { value: "750" } });
    const cta = screen.getByRole("button", { name: /confirmer l'import \(2\)/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);

    expect(onConfirm).toHaveBeenCalledWith([
      { name: "Awa Diallo", phoneNumber: "+221777915898", dailyAmount: 500 },
      { name: "Cheikh Ndiaye", phoneNumber: "+221770000000", dailyAmount: 750 },
    ]);
  });

  it("CTA stays disabled when an amount is below 100 FCFA", () => {
    renderStep({ contacts: [CONTACTS[0]!] });
    const input = screen.getByLabelText("Cotisation (FCFA)");
    fireEvent.change(input, { target: { value: "50" } });
    expect(screen.getByRole("button", { name: /confirmer l'import \(1\)/i })).toBeDisabled();
  });

  it("Annuler invokes onCancel", () => {
    const { onCancel } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: /annuler/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = renderStep();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
