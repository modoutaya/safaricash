import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

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

async function getToOtpStep() {
  rpcMock.mockResolvedValue({ data: true, error: null });
  signInWithOtpMock.mockResolvedValue({ error: null });
  render(<LoginForm onNonRegistered={vi.fn()} onSignedIn={vi.fn()} />);
  const input = screen.getByLabelText("Numéro de téléphone");
  fireEvent.change(input, { target: { value: "+221777915898" } });
  await act(async () => {
    fireEvent.submit(input.closest("form")!);
  });
}

describe("OtpStep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpcMock.mockReset();
    signInWithOtpMock.mockReset();
    verifyOtpMock.mockReset();
    fromLimitMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("initially shows the resend countdown (30s) on the resend button", async () => {
    await getToOtpStep();
    expect(screen.getByRole("button", { name: /Renvoyer dans 30 s/ })).toBeDisabled();
  });

  it("enables the resend button after the 30s cooldown elapses", async () => {
    await getToOtpStep();
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByRole("button", { name: "Renvoyer le code" })).not.toBeDisabled();
  });

  it("shows the locked banner after 3 invalid OTP attempts", async () => {
    verifyOtpMock.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: "invalid_credentials", status: 401, message: "Invalid" },
    });
    await getToOtpStep();

    const slots = screen.getAllByLabelText(/Chiffre \d du code/);
    expect(slots).toHaveLength(6);

    // The OtpStep auto-submits on the 6th digit — we drive that by
    // dispatching keystrokes directly on the hidden <input>. input-otp
    // renders its real input inside the container; query by role textbox.
    const otpInput = screen.getByRole("textbox");

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.input(otpInput, { target: { value: "000000" } });
      });
    }

    expect(screen.getByText(/Trop de tentatives\. Réessayez dans 5 minutes\./)).toBeInTheDocument();
  });

  it("calls onSignedIn on a valid verify + count query", async () => {
    verifyOtpMock.mockResolvedValue({
      data: { session: { user: { id: "u-1" } } },
      error: null,
    });
    fromLimitMock.mockResolvedValue({ count: 2, error: null });

    rpcMock.mockResolvedValue({ data: true, error: null });
    signInWithOtpMock.mockResolvedValue({ error: null });
    const onSignedIn = vi.fn();
    render(<LoginForm onNonRegistered={vi.fn()} onSignedIn={onSignedIn} />);

    const input = screen.getByLabelText("Numéro de téléphone");
    fireEvent.change(input, { target: { value: "+221777915898" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    const otpInput = screen.getByRole("textbox");
    await act(async () => {
      fireEvent.input(otpInput, { target: { value: "654321" } });
    });

    expect(onSignedIn).toHaveBeenCalledWith({ userId: "u-1", memberCount: 2 });
  });
});
