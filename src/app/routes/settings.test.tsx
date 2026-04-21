import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("renders the Plus heading", () => {
    render(<SettingsRoute />);
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

  it("disables the button and shows loading copy while sign-out is in flight", async () => {
    // Hold the helper open so the button stays in the pending state long
    // enough to assert against.
    let resolveSignOut!: () => void;
    requestSignOutMock.mockImplementation(
      () => new Promise<void>((resolve) => (resolveSignOut = resolve)),
    );
    render(<SettingsRoute />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /se déconnecter/i }));
    });

    const loadingBtn = screen.getByRole("button", { name: /déconnexion/i });
    expect(loadingBtn).toBeDisabled();

    await act(async () => {
      resolveSignOut();
    });
  });
});
