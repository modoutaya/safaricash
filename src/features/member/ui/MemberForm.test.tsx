// Story 2.2 → 2.5 — MemberForm tests (RHF + Zod + jest-axe).
// Story 2.5 refactor: form is presentation-only — owners pass `onSubmit`
// + `isPending` + `errorCode`. Tests inject those directly (no supabase
// mock needed at the form level — that's covered by useCreateMember /
// useUpdateMember tests separately).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemberForm, type MemberFormProps } from "./MemberForm";
import type { CreateMemberInput } from "../types";

expect.extend(toHaveNoViolations);

function renderForm(overrides: Partial<MemberFormProps> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  const props: MemberFormProps = {
    mode: "create",
    onSubmit,
    onCancel,
    isPending: false,
    errorCode: null,
    ...overrides,
  };
  const utils = render(<MemberForm {...props} />);
  return { ...utils, onSubmit, onCancel };
}

describe("MemberForm — create mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the 3 labelled fields + submit CTA disabled by default", () => {
    renderForm();
    expect(screen.getByLabelText("Nom")).toBeInTheDocument();
    expect(screen.getByLabelText("Numéro de téléphone")).toBeInTheDocument();
    expect(screen.getByLabelText("Cotisation quotidienne (FCFA)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ajouter ce membre/i })).toBeDisabled();
  });

  it("shows inline error when name is too short after blur", async () => {
    renderForm();
    const name = screen.getByLabelText("Nom");
    fireEvent.change(name, { target: { value: "A" } });
    fireEvent.blur(name);
    await waitFor(() => expect(screen.getByText(/au moins 2 caract/i)).toBeInTheDocument());
  });

  it("shows inline error when phone is malformed (non-empty invalid)", async () => {
    renderForm();
    const phone = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(phone, { target: { value: "12345" } });
    fireEvent.blur(phone);
    await waitFor(() => expect(screen.getByText(/numéro invalide/i)).toBeInTheDocument());
  });

  it("keeps the CTA disabled while the phone is empty (now required)", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Awa Diallo" } });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "500" },
    });
    // Phone left empty → form invalid → CTA stays disabled.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /ajouter ce membre/i })).toBeDisabled(),
    );
    // A valid phone enables it.
    fireEvent.change(screen.getByLabelText("Numéro de téléphone"), {
      target: { value: "+221777915898" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /ajouter ce membre/i })).toBeEnabled(),
    );
  });

  it("shows the cycle recap once a valid daily amount is entered", async () => {
    renderForm();
    expect(screen.queryByText("Récapitulatif")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "500" },
    });
    await waitFor(() => expect(screen.getByText("Récapitulatif")).toBeInTheDocument());
    // Total du cycle = 500 × 30 = 15 000 F CFA.
    expect(screen.getByText(/15\s?000 F CFA/)).toBeInTheDocument();
  });

  it("shows error when amount is below the 100 FCFA floor", async () => {
    renderForm();
    const amount = screen.getByLabelText("Cotisation quotidienne (FCFA)");
    fireEvent.change(amount, { target: { value: "50" } });
    fireEvent.blur(amount);
    await waitFor(() => expect(screen.getByText(/minimum 100 fcfa/i)).toBeInTheDocument());
  });

  it("calls onSubmit with parsed values on valid submit", async () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Awa Diallo" } });
    fireEvent.change(screen.getByLabelText("Numéro de téléphone"), {
      target: { value: "+221777915898" },
    });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "500" },
    });

    const cta = screen.getByRole("button", { name: /ajouter ce membre/i });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: "Awa Diallo",
        phoneNumber: "+221777915898",
        dailyAmount: 500,
      }),
    );
  });

  it("accepts a bare 9-digit phone (no +221) and normalises it on submit", async () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Awa Diallo" } });
    fireEvent.change(screen.getByLabelText("Numéro de téléphone"), {
      target: { value: "777915898" },
    });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "500" },
    });

    const cta = screen.getByRole("button", { name: /ajouter ce membre/i });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: "Awa Diallo",
        phoneNumber: "+221777915898",
        dailyAmount: 500,
      }),
    );
  });

  it("renders the error banner when errorCode = 'unauthorized'", () => {
    renderForm({ errorCode: "unauthorized" });
    expect(screen.getByText(/vous devez être reconnecté/i)).toBeInTheDocument();
  });

  it("renders 'Ajout en cours…' label and disables CTA when isPending=true", () => {
    renderForm({ isPending: true });
    expect(screen.getByRole("button", { name: /ajout en cours…/i })).toBeDisabled();
  });

  it("Annuler button triggers onCancel without submitting", () => {
    const { onCancel, onSubmit } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /annuler/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = renderForm();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("MemberForm — edit mode", () => {
  const INITIAL: CreateMemberInput = {
    name: "Awa Diallo",
    phoneNumber: "+221777915898",
    dailyAmount: 500,
  };

  it("renders the edit title + initial values + 'Enregistrer' CTA", () => {
    renderForm({ mode: "edit", initialValues: INITIAL });
    expect(
      screen.getByRole("heading", { level: 1, name: /modifier le membre/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nom")).toHaveValue("Awa Diallo");
    expect(screen.getByLabelText("Numéro de téléphone")).toHaveValue("+221777915898");
    expect(screen.getByLabelText("Cotisation quotidienne (FCFA)")).toHaveValue(500);
    // Pristine edit-mode → CTA disabled (no dirty fields).
    expect(screen.getByRole("button", { name: /^enregistrer$/i })).toBeDisabled();
  });

  it("enables CTA only after a field becomes dirty", async () => {
    renderForm({ mode: "edit", initialValues: INITIAL });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "1000" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^enregistrer$/i })).toBeEnabled(),
    );
  });

  it("calls onSubmit with the new values after a dirty submit", async () => {
    const { onSubmit } = renderForm({ mode: "edit", initialValues: INITIAL });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "1000" },
    });
    const cta = screen.getByRole("button", { name: /^enregistrer$/i });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: "Awa Diallo",
        phoneNumber: "+221777915898",
        dailyAmount: 1000,
      }),
    );
  });

  it("renders the edit-mode error banner for not_found", () => {
    renderForm({ mode: "edit", initialValues: INITIAL, errorCode: "not_found" });
    expect(screen.getByText(/membre introuvable/i)).toBeInTheDocument();
  });

  it("renders the impact alert via the belowFields render-prop slot", () => {
    renderForm({
      mode: "edit",
      initialValues: INITIAL,
      belowFields: ({ values }) =>
        values.dailyAmount !== INITIAL.dailyAmount ? (
          <p data-testid="impact-banner">impact</p>
        ) : null,
    });
    // No banner on initial render.
    expect(screen.queryByTestId("impact-banner")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "999" },
    });
    expect(screen.getByTestId("impact-banner")).toBeInTheDocument();
  });
});
