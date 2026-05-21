// Story 7.4 — SettlementReauthDialog component tests.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(toHaveNoViolations);

const mutateAsyncMock = vi.fn();
const useCommitSettlementMock = vi.fn();

vi.mock("../api/useCommitSettlement", () => {
  return {
    useCommitSettlement: () => useCommitSettlementMock(),
  };
});

vi.mock("../api/commitSettlementError", () => {
  class CommitSettlementError extends Error {
    public readonly code: string;
    public readonly serverPayout: number | undefined;
    constructor(code: string, message: string, serverPayout?: number) {
      super(message);
      this.code = code;
      this.serverPayout = serverPayout;
      this.name = "CommitSettlementError";
    }
  }
  return { CommitSettlementError };
});

import { CommitSettlementError } from "../api/commitSettlementError";
import { SettlementReauthDialog } from "./SettlementReauthDialog";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const CYCLE_ID = "22222222-2222-4222-8222-222222222222";
const EXPECTED_PAYOUT = 11_500;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function renderDialog(overrides: { isPending?: boolean } = {}) {
  const onOpenChange = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  useCommitSettlementMock.mockReturnValue({
    isPending: overrides.isPending ?? false,
    error: null,
    mutateAsync: mutateAsyncMock,
  });
  const utils = render(
    <SettlementReauthDialog
      open
      onOpenChange={onOpenChange}
      memberId={MEMBER_ID}
      cycleId={CYCLE_ID}
      memberName="Awa Diallo"
      expectedPayout={EXPECTED_PAYOUT}
      onSuccess={onSuccess}
      onError={onError}
    />,
  );
  return { ...utils, onOpenChange, onSuccess, onError };
}

describe("SettlementReauthDialog", () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    useCommitSettlementMock.mockReset();
  });

  it("renders title, body with payout interpolation, password input, disabled submit", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { level: 2, name: /Confirmation requise/ }),
    ).toBeInTheDocument();
    // Body includes member first name + payout (NBSP-grouped)
    expect(screen.getByText(/Awa/)).toBeInTheDocument();
    expect(screen.getByText(/11[\s\u00a0]500 FCFA/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mot de passe/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Valider le paiement/ })).toBeDisabled();
  });

  it("enables submit once a non-empty password is typed", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Mot de passe/), {
      target: { value: "Pw-test" },
    });
    expect(screen.getByRole("button", { name: /Valider le paiement/ })).toBeEnabled();
  });

  it("whitespace-only password keeps submit disabled (Story 6.6 P8 pattern)", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Mot de passe/), {
      target: { value: "   " },
    });
    expect(screen.getByRole("button", { name: /Valider le paiement/ })).toBeDisabled();
  });

  it("happy path — calls mutateAsync with trimmed password, fires onSuccess + onOpenChange(false)", async () => {
    const result = {
      ok: true as const,
      settlement_transaction_id: "33333333-3333-4333-8333-333333333333",
      settled_payout: 11_500,
      settled_at: "2026-05-14T12:34:56Z",
    };
    mutateAsyncMock.mockResolvedValue(result);
    const { onSuccess, onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: " Pw-test " } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
    // Trimmed password sent to mutation.
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      memberId: MEMBER_ID,
      cycleId: CYCLE_ID,
      expectedPayout: EXPECTED_PAYOUT,
      password: "Pw-test",
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(result));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("Enter key submits the form (Story 6.6 P3 form-wrap)", async () => {
    mutateAsyncMock.mockResolvedValue({
      ok: true,
      settlement_transaction_id: "x",
      settled_payout: 11_500,
      settled_at: "x",
    });
    renderDialog();
    const input = screen.getByLabelText(/Mot de passe/);
    fireEvent.change(input, { target: { value: "Pw-test" } });
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
  });

  it("credentials_invalid — clears password, shows inline alert, stays open", async () => {
    mutateAsyncMock.mockRejectedValue(new CommitSettlementError("credentials_invalid", "Invalid"));
    const { onError, onOpenChange } = renderDialog();

    const input = screen.getByLabelText(/Mot de passe/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Mot de passe incorrect/),
    );
    // Password cleared.
    expect(input.value).toBe("");
    // Dialog stays open.
    expect(onError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("rate_limited — shows inline alert, stays open", async () => {
    mutateAsyncMock.mockRejectedValue(new CommitSettlementError("rate_limited", "Too many"));
    const { onError, onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "Pw-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Trop de tentatives/));
    expect(onError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("payout_mismatch — surfaces upstream via onError, dialog closes", async () => {
    mutateAsyncMock.mockRejectedValue(new CommitSettlementError("payout_mismatch", "mismatch"));
    const { onError, onOpenChange } = renderDialog();

    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "Pw-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const errArg = onError.mock.calls[0]?.[0];
    expect(errArg.code).toBe("payout_mismatch");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("isPending — input + buttons disabled + submit label switches to 'Vérification…'", () => {
    renderDialog({ isPending: true });
    expect(screen.getByLabelText(/Mot de passe/)).toBeDisabled();
    expect(screen.getByRole("button", { name: /Vérification…/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Annuler/ })).toBeDisabled();
  });

  it("Cancel button closes the dialog", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /Annuler/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("axe-clean across idle + submitting states", async () => {
    const cases = [{ isPending: false }, { isPending: true }];
    for (const c of cases) {
      // Mock BEFORE render so the body component reads the right isPending.
      useCommitSettlementMock.mockReturnValue({
        isPending: c.isPending,
        error: null,
        mutateAsync: mutateAsyncMock,
      });
      const { container, unmount } = render(
        <SettlementReauthDialog
          open
          onOpenChange={vi.fn()}
          memberId={MEMBER_ID}
          cycleId={CYCLE_ID}
          memberName="Awa Diallo"
          expectedPayout={EXPECTED_PAYOUT}
          onSuccess={vi.fn()}
          onError={vi.fn()}
        />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });

  // Code-review patch #4 — axe also clean once the inline alert renders
  // (spec AC #8 third state: error-shown). The alert is a <p role="alert">,
  // a live region that axe rules around landmark / role can flag.
  it("axe-clean across the inline-error state (credentials_invalid)", async () => {
    useCommitSettlementMock.mockReturnValue({
      isPending: false,
      error: null,
      mutateAsync: mutateAsyncMock,
    });
    mutateAsyncMock.mockRejectedValue(new CommitSettlementError("credentials_invalid", "Invalid"));
    const { container } = render(
      <SettlementReauthDialog
        open
        onOpenChange={vi.fn()}
        memberId={MEMBER_ID}
        cycleId={CYCLE_ID}
        memberName="Awa Diallo"
        expectedPayout={EXPECTED_PAYOUT}
        onSuccess={vi.fn()}
        onError={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
