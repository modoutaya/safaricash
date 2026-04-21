// Story 2.2 — MemberForm tests (RHF + Zod + jest-axe).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
  },
}));

import { MemberForm } from "./MemberForm";

expect.extend(toHaveNoViolations);

function TestWrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderForm() {
  const onSuccess = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <TestWrapper>
      <MemberForm onSuccess={onSuccess} onCancel={onCancel} />
    </TestWrapper>,
  );
  return { ...utils, onSuccess, onCancel };
}

describe("MemberForm", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("renders the 3 labelled fields + submit CTA disabled by default", () => {
    renderForm();
    expect(screen.getByLabelText("Nom")).toBeInTheDocument();
    expect(screen.getByLabelText("Numéro de téléphone (optionnel)")).toBeInTheDocument();
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
    const phone = screen.getByLabelText("Numéro de téléphone (optionnel)");
    fireEvent.change(phone, { target: { value: "12345" } });
    fireEvent.blur(phone);
    await waitFor(() => expect(screen.getByText(/numéro invalide/i)).toBeInTheDocument());
  });

  it("accepts empty phone as valid", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Awa Diallo" } });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "500" },
    });
    fireEvent.blur(screen.getByLabelText("Numéro de téléphone (optionnel)"));
    // The CTA should become enabled even with phone empty.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /ajouter ce membre/i })).toBeEnabled(),
    );
  });

  it("shows error when amount is below the 100 FCFA floor", async () => {
    renderForm();
    const amount = screen.getByLabelText("Cotisation quotidienne (FCFA)");
    fireEvent.change(amount, { target: { value: "50" } });
    fireEvent.blur(amount);
    await waitFor(() => expect(screen.getByText(/minimum 100 fcfa/i)).toBeInTheDocument());
  });

  it("enables CTA and calls onSuccess after a valid submit", async () => {
    rpcMock.mockResolvedValue({ data: "member-uuid-42", error: null });
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Awa Diallo" } });
    fireEvent.change(screen.getByLabelText("Numéro de téléphone (optionnel)"), {
      target: { value: "+221777915898" },
    });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "500" },
    });

    const cta = screen.getByRole("button", { name: /ajouter ce membre/i });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith("member-uuid-42", expect.any(Object)),
    );
    expect(rpcMock).toHaveBeenCalledWith("create_member_with_cycle", {
      p_name: "Awa Diallo",
      p_phone_number: "+221777915898",
      p_daily_amount: 500,
    });
  });

  it("renders the error banner on invalid_credentials RPC error", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "permission denied", code: "42501" },
    });
    renderForm();

    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Moussa" } });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "300" },
    });

    const cta = screen.getByRole("button", { name: /ajouter ce membre/i });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);

    await waitFor(() =>
      expect(screen.getByText(/vous devez être reconnecté/i)).toBeInTheDocument(),
    );
  });

  it("Annuler button triggers onCancel without submitting", () => {
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /annuler/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = renderForm();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
