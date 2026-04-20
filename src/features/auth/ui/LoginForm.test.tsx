import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";

const rpcMock = vi.fn();
const signInWithOtpMock = vi.fn();
const verifyOtpMock = vi.fn();
const fromLimitMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: {
      signInWithOtp: (args: unknown) => signInWithOtpMock(args),
      verifyOtp: (args: unknown) => verifyOtpMock(args),
    },
    from: () => ({
      select: () => ({ limit: (...args: unknown[]) => fromLimitMock(...args) }),
    }),
  },
}));

import { LoginForm } from "@/features/auth/ui/LoginForm";

expect.extend(toHaveNoViolations);

describe("LoginForm (phone step)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    signInWithOtpMock.mockReset();
    verifyOtpMock.mockReset();
    fromLimitMock.mockReset();
  });

  function renderDefault(overrides: Partial<React.ComponentProps<typeof LoginForm>> = {}) {
    const onNonRegistered = overrides.onNonRegistered ?? vi.fn();
    const onSignedIn = overrides.onSignedIn ?? vi.fn();
    return {
      ...render(<LoginForm onNonRegistered={onNonRegistered} onSignedIn={onSignedIn} />),
      onNonRegistered,
      onSignedIn,
    };
  }

  it("disables the CTA until the phone matches the Senegal E.164 format", () => {
    renderDefault();
    const cta = screen.getByRole("button", { name: /recevoir le code/i });
    expect(cta).toBeDisabled();
    const input = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(input, { target: { value: "123" } });
    expect(cta).toBeDisabled();
    fireEvent.change(input, { target: { value: "+221777915898" } });
    expect(cta).not.toBeDisabled();
  });

  it("shows 'Numéro invalide' inline help text when the phone does not match", () => {
    renderDefault();
    const input = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(input, { target: { value: "12345" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toHaveTextContent("Numéro invalide");
  });

  it("calls onNonRegistered when RPC returns false (no Termii call)", async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });
    const { onNonRegistered } = renderDefault();

    const input = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(input, { target: { value: "+221777915898" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(onNonRegistered).toHaveBeenCalledWith("+221777915898"));
    expect(signInWithOtpMock).not.toHaveBeenCalled();
  });

  it("transitions to OTP step on successful send (in-place, no route change)", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    renderDefault();

    const input = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(input, { target: { value: "+221777915898" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() =>
      expect(screen.getByText(/Nous vous avons envoyé un code/)).toBeInTheDocument(),
    );
    // The phone label should no longer be in the DOM — we are on the OTP step.
    expect(screen.queryByLabelText("Numéro de téléphone")).not.toBeInTheDocument();
  });

  it("applies the phone mask in the OTP subtitle", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    renderDefault();

    const input = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(input, { target: { value: "+221777915898" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(screen.getByText(/\+221 77 X 91 58 98/)).toBeInTheDocument());
  });

  it("has no axe-detectable a11y violations on the phone step", async () => {
    const { container } = renderDefault();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
