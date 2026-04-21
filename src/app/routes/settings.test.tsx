import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the sign-out helper — we only care that the button wires to it.
// ---------------------------------------------------------------------------

const requestSignOutMock = vi.fn();

vi.mock("@/features/auth/api/signOut", () => ({
  requestSignOut: (reason: unknown) => requestSignOutMock(reason),
}));

import SettingsRoute from "@/app/routes/settings";

describe("SettingsRoute", () => {
  beforeEach(() => {
    requestSignOutMock.mockReset();
    requestSignOutMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it("renders inside a <main> landmark with the Plus heading", () => {
    render(<SettingsRoute />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /plus/i })).toBeInTheDocument();
  });

  it("renders a Se déconnecter button", () => {
    render(<SettingsRoute />);
    expect(screen.getByRole("button", { name: /se déconnecter/i })).toBeEnabled();
  });

  it("calls requestSignOut('explicit') on button click", async () => {
    render(<SettingsRoute />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /se déconnecter/i }));
    });
    expect(requestSignOutMock).toHaveBeenCalledWith("explicit");
  });

  it("disables the button and sets aria-busy while sign-out is in flight; re-enables on resolve", async () => {
    // Hold the helper open so the button stays in the pending state long
    // enough to assert against.
    let resolveSignOut!: () => void;
    requestSignOutMock.mockImplementation(
      () => new Promise<void>((resolve) => (resolveSignOut = resolve)),
    );
    render(<SettingsRoute />);

    const btn = screen.getByRole("button", { name: /se déconnecter/i });

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(btn).toBeDisabled();
    expect(btn.getAttribute("aria-busy")).toBe("true");
    // The loading copy lives in a polite live region (sr-only), not the
    // button's accessible name — accessible name stays stable during flight.
    expect(screen.getByRole("status")).toHaveTextContent(/déconnexion/i);

    await act(async () => {
      resolveSignOut();
    });

    await waitFor(() => expect(btn).toBeEnabled());
    expect(btn.getAttribute("aria-busy")).toBe("false");
  });

  it("drops the second click while a sign-out is already in flight (double-tap guard)", async () => {
    let resolveSignOut!: () => void;
    requestSignOutMock.mockImplementation(
      () => new Promise<void>((resolve) => (resolveSignOut = resolve)),
    );
    render(<SettingsRoute />);
    const btn = screen.getByRole("button", { name: /se déconnecter/i });

    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });

    expect(requestSignOutMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSignOut();
    });
  });
});
