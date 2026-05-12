// Story 6.6 — ResendHistoryDialog component tests.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutateAsyncMock = vi.fn();
const useResendHistoryMock = vi.fn();

// `vi.mock` is hoisted to the very top of the file, so the factory cannot
// reference top-level constants from the test file. The typed-error class
// is declared INSIDE the factory and re-exported via the same module so
// the test body can `import { ResendHistoryError }` from the mocked path.
vi.mock("../api/useResendHistory", () => {
  class ResendHistoryError extends Error {
    public readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "ResendHistoryError";
    }
  }
  return {
    useResendHistory: () => useResendHistoryMock(),
    ResendHistoryError,
  };
});

import { ResendHistoryError } from "../api/useResendHistory";
import { ResendHistoryDialog } from "./ResendHistoryDialog";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const CYCLE_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function renderDialog() {
  const onOpenChange = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  useResendHistoryMock.mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: mutateAsyncMock,
  });
  const utils = render(
    <ResendHistoryDialog
      open
      onOpenChange={onOpenChange}
      memberId={MEMBER_ID}
      cycleId={CYCLE_ID}
      memberName="Fatou Ndiaye"
      onSuccess={onSuccess}
      onError={onError}
    />,
  );
  return { ...utils, onOpenChange, onSuccess, onError };
}

describe("ResendHistoryDialog", () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    useResendHistoryMock.mockReset();
  });

  it("renders the title + body + password input + disabled confirm button", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { level: 2, name: /renvoyer l'historique du cycle/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/le saver recevra un sms de rappel pour chaque transaction/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/confirmez votre mot de passe/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^confirmer$/i })).toBeDisabled();
  });

  it("enables Confirmer once a password is typed", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
      target: { value: "Pw-test" },
    });
    expect(screen.getByRole("button", { name: /^confirmer$/i })).toBeEnabled();
  });

  it("happy path — calls mutateAsync, fires onSuccess, closes", async () => {
    mutateAsyncMock.mockResolvedValue({ enqueued: 3, reason: null });
    const { onSuccess, onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
      target: { value: "Pw-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^confirmer$/i }));

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      memberId: MEMBER_ID,
      cycleId: CYCLE_ID,
      password: "Pw-test",
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ enqueued: 3, reason: null }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("credentials_invalid — clears password, shows inline alert, stays open", async () => {
    mutateAsyncMock.mockRejectedValue(new ResendHistoryError("credentials_invalid", "Invalid"));
    const { onError, onOpenChange } = renderDialog();

    const passwordInput = screen.getByLabelText(
      /confirmez votre mot de passe/i,
    ) as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /^confirmer$/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/mot de passe invalide/i),
    );
    expect(passwordInput.value).toBe("");
    expect(onError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("rate_limited — shows rate-limited copy, stays open", async () => {
    mutateAsyncMock.mockRejectedValue(new ResendHistoryError("rate_limited", "Too many"));
    const { onError, onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
      target: { value: "Pw-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^confirmer$/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/trop de tentatives/i));
    expect(onError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("network/internal error — fires onError, closes dialog", async () => {
    mutateAsyncMock.mockRejectedValue(new ResendHistoryError("network", "Failed to fetch"));
    const { onError, onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
      target: { value: "Pw-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^confirmer$/i }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect((onError.mock.calls[0]?.[0] as ResendHistoryError)?.code).toBe("network");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
