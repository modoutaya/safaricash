// Story 4.6 — NewTransactionForm tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { NewTransactionForm, type NewTransactionFormProps } from "./NewTransactionForm";

expect.extend(toHaveNoViolations);

const MEMBERS = [
  { id: "m1", name: "Awa Diallo", dailyAmount: 500 },
  { id: "m2", name: "Moussa Koné", dailyAmount: 1000 },
];

function renderForm(overrides: Partial<NewTransactionFormProps> = {}) {
  const props: NewTransactionFormProps = {
    members: MEMBERS,
    selectedMemberId: "m1",
    dailyAmount: 500,
    daysRemaining: 10,
    isPending: false,
    onBack: vi.fn(),
    onSelectMember: vi.fn(),
    onViewProfile: vi.fn(),
    onSubmitContribution: vi.fn(),
    onSubmitRattrapage: vi.fn(),
    onGoToAdvance: vi.fn(),
    ...overrides,
  };
  return { ...render(<NewTransactionForm {...props} />), props };
}

describe("NewTransactionForm", () => {
  it("renders the topbar, the form card, the member select and the type select", () => {
    renderForm();
    expect(screen.getByRole("heading", { level: 1, name: /^transaction$/i })).toBeInTheDocument();
    expect(screen.getByText(/détails de l'opération/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sélectionner le membre/i)).toHaveValue("m1");
    expect(screen.getByLabelText(/type d'opération/i)).toHaveValue("contribution");
  });

  it("defaults to Cotisation and shows the suggested amount", () => {
    renderForm({ dailyAmount: 750, selectedMemberId: "m1", members: [MEMBERS[0]!] });
    expect(screen.getByText("750")).toBeInTheDocument();
    expect(screen.getByText(/montant suggéré pour ce membre/i)).toBeInTheDocument();
  });

  it("submits the suggested amount when no custom amount is entered", () => {
    const { props } = renderForm({ dailyAmount: 500 });
    fireEvent.click(screen.getByRole("button", { name: /confirmer la cotisation/i }));
    expect(props.onSubmitContribution).toHaveBeenCalledWith(500);
  });

  it("submits the custom amount when one is entered", () => {
    const { props } = renderForm({ dailyAmount: 500 });
    fireEvent.change(screen.getByLabelText(/montant personnalisé/i), {
      target: { value: "1200" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirmer la cotisation/i }));
    expect(props.onSubmitContribution).toHaveBeenCalledWith(1200);
  });

  it("re-navigates when the member select changes", () => {
    const { props } = renderForm();
    fireEvent.change(screen.getByLabelText(/sélectionner le membre/i), {
      target: { value: "m2" },
    });
    expect(props.onSelectMember).toHaveBeenCalledWith("m2");
  });

  it("disables rattrapage day options past daysRemaining and submits the picked count", () => {
    const { props } = renderForm({ daysRemaining: 2 });
    fireEvent.change(screen.getByLabelText(/type d'opération/i), {
      target: { value: "rattrapage" },
    });
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
    fireEvent.change(screen.getByLabelText(/type d'opération/i), {
      target: { value: "advance" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continuer vers prêt express/i }));
    expect(props.onGoToAdvance).toHaveBeenCalled();
    expect(props.onSubmitContribution).not.toHaveBeenCalled();
  });

  it("the back button calls onBack", () => {
    const { props } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /^retour$/i }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it("the profile link calls onViewProfile", () => {
    const { props } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /voir le profil/i }));
    expect(props.onViewProfile).toHaveBeenCalled();
  });

  it("axe-clean", async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});
