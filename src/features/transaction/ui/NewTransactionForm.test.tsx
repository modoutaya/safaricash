// Story 4.6 — NewTransactionForm tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { NewTransactionForm, type NewTransactionFormProps } from "./NewTransactionForm";

expect.extend(toHaveNoViolations);

function renderForm(overrides: Partial<NewTransactionFormProps> = {}) {
  const props: NewTransactionFormProps = {
    memberName: "Awa Diallo",
    dailyAmount: 500,
    daysRemaining: 10,
    isPending: false,
    onBack: vi.fn(),
    onViewProfile: vi.fn(),
    onSubmitContribution: vi.fn(),
    onSubmitRattrapage: vi.fn(),
    onGoToAdvance: vi.fn(),
    ...overrides,
  };
  return { ...render(<NewTransactionForm {...props} />), props };
}

describe("NewTransactionForm", () => {
  it("renders the topbar, the member and the 3 type options", () => {
    renderForm();
    expect(
      screen.getByRole("heading", { level: 1, name: /nouvelle transaction/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Awa Diallo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cotisation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rattrapage" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prêt" })).toBeInTheDocument();
  });

  it("defaults to Cotisation with the amount pre-filled to the daily amount", () => {
    renderForm({ dailyAmount: 750 });
    expect(screen.getByLabelText(/montant de la cotisation/i)).toHaveValue(750);
  });

  it("submits a contribution with the editable amount", () => {
    const { props } = renderForm({ dailyAmount: 500 });
    fireEvent.change(screen.getByLabelText(/montant de la cotisation/i), {
      target: { value: "1200" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirmer la cotisation/i }));
    expect(props.onSubmitContribution).toHaveBeenCalledWith(1200);
  });

  it("disables rattrapage day options past daysRemaining and submits the picked count", () => {
    const { props } = renderForm({ daysRemaining: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Rattrapage" }));
    // RATTRAPAGE_DAY_OPTIONS = [2, 3, 4]; daysRemaining = 2 → 3 and 4 disabled.
    expect(screen.getByRole("button", { name: "3 jours" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "4 jours" })).toBeDisabled();
    const two = screen.getByRole("button", { name: "2 jours" });
    expect(two).toBeEnabled();
    fireEvent.click(two);
    fireEvent.click(screen.getByRole("button", { name: /confirmer le rattrapage/i }));
    expect(props.onSubmitRattrapage).toHaveBeenCalledWith(2);
  });

  it("routes the Prêt type to the advance flow", () => {
    const { props } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Prêt" }));
    fireEvent.click(screen.getByRole("button", { name: /continuer vers prêt express/i }));
    expect(props.onGoToAdvance).toHaveBeenCalled();
    expect(props.onSubmitContribution).not.toHaveBeenCalled();
  });

  it("the back button calls onBack", () => {
    const { props } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^retour$/i }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it("the member name links to the profile via onViewProfile", () => {
    const { props } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /voir le profil/i }));
    expect(props.onViewProfile).toHaveBeenCalled();
  });

  it("axe-clean", async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});
