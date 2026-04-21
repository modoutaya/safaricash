// Story 1.5b — LoginForm (single-screen phone + password) tests.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";

const signInWithPasswordMock = vi.fn();
const fromLimitMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    auth: {
      signInWithPassword: (args: unknown) => signInWithPasswordMock(args),
    },
    from: () => ({
      select: () => ({ limit: (...args: unknown[]) => fromLimitMock(...args) }),
    }),
  },
}));

import { LoginForm } from "@/features/auth/ui/LoginForm";
import type { ComponentProps } from "react";

expect.extend(toHaveNoViolations);

describe("LoginForm", () => {
  beforeEach(() => {
    signInWithPasswordMock.mockReset();
    fromLimitMock.mockReset();
  });

  function renderDefault(overrides: Partial<ComponentProps<typeof LoginForm>> = {}) {
    const onSignedIn = overrides.onSignedIn ?? vi.fn();
    return { ...render(<LoginForm onSignedIn={onSignedIn} />), onSignedIn };
  }

  it("disables the CTA until BOTH phone is valid AND password is non-empty", () => {
    renderDefault();
    const cta = screen.getByRole("button", { name: /se connecter/i });
    expect(cta).toBeDisabled();

    const phone = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(phone, { target: { value: "+221777915898" } });
    expect(cta).toBeDisabled(); // still no password

    const password = screen.getByLabelText("Mot de passe");
    fireEvent.change(password, { target: { value: "pw" } });
    expect(cta).not.toBeDisabled();

    // Clearing the password re-disables.
    fireEvent.change(password, { target: { value: "" } });
    expect(cta).toBeDisabled();
  });

  it("shows 'Numéro invalide' inline help when phone shape is wrong", () => {
    renderDefault();
    const phone = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(phone, { target: { value: "12345" } });
    fireEvent.blur(phone);
    expect(screen.getByRole("alert")).toHaveTextContent("Numéro invalide");
  });

  it("show/hide password toggle swaps input type + aria-label", () => {
    renderDefault();
    const password = screen.getByLabelText("Mot de passe") as HTMLInputElement;
    expect(password.type).toBe("password");
    const toggle = screen.getByRole("button", { name: /afficher le mot de passe/i });
    fireEvent.click(toggle);
    expect(password.type).toBe("text");
    expect(screen.getByRole("button", { name: /masquer le mot de passe/i })).toBeInTheDocument();
  });

  it("submits with phone + password and calls onSignedIn on success", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: { user: { id: "user-42" } } },
      error: null,
    });
    fromLimitMock.mockResolvedValue({ count: 0, error: null });
    const { onSignedIn } = renderDefault();

    fireEvent.change(screen.getByLabelText("Numéro de téléphone"), {
      target: { value: "+221777915898" },
    });
    fireEvent.change(screen.getByLabelText("Mot de passe"), {
      target: { value: "pw123!" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /se connecter/i }).closest("form")!);

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(signInWithPasswordMock).toHaveBeenCalledWith({
      phone: "+221777915898",
      password: "pw123!",
    });
  });

  it("renders the inline error banner on invalid_credentials", async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", status: 400, message: "bad" },
    });
    const { onSignedIn } = renderDefault();

    fireEvent.change(screen.getByLabelText("Numéro de téléphone"), {
      target: { value: "+221777915898" },
    });
    fireEvent.change(screen.getByLabelText("Mot de passe"), {
      target: { value: "wrong" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /se connecter/i }).closest("form")!);

    await waitFor(() =>
      expect(screen.getByText(/Numéro ou mot de passe incorrect/i)).toBeInTheDocument(),
    );
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("renders a tel: link to the founder support phone on 'Mot de passe oublié ?'", () => {
    renderDefault();
    const link = screen.getByRole("link", { name: /mot de passe oublié/i });
    expect(link).toHaveAttribute("href", expect.stringMatching(/^tel:\+221/));
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = renderDefault();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
