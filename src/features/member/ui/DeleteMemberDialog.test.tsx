// Story 2.6 — DeleteMemberDialog component tests.
// Mocks useDeleteMember + supabase.functions.invoke for the re-auth call.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutateAsyncMock = vi.fn();
const resetMock = vi.fn();
const useDeleteMemberMock = vi.fn();
const invokeMock = vi.fn();

vi.mock("../api/useDeleteMember", () => ({
  useDeleteMember: () => useDeleteMemberMock(),
}));

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

import { DeleteMemberDialog } from "./DeleteMemberDialog";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function renderDialog(
  overrides: Partial<{ open: boolean; transactionsCount: number; cyclesCount: number }> = {},
) {
  const onOpenChange = vi.fn();
  const onSuccess = vi.fn();
  const onMutationFailure = vi.fn();
  useDeleteMemberMock.mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: mutateAsyncMock,
    reset: resetMock,
  });
  const utils = render(
    <DeleteMemberDialog
      open={overrides.open ?? true}
      onOpenChange={onOpenChange}
      memberId={MEMBER_ID}
      memberName="Awa Diallo"
      transactionsCount={overrides.transactionsCount ?? 3}
      cyclesCount={overrides.cyclesCount ?? 1}
      onSuccess={onSuccess}
      onMutationFailure={onMutationFailure}
    />,
  );
  return { ...utils, onOpenChange, onSuccess, onMutationFailure };
}

describe("DeleteMemberDialog", () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    resetMock.mockReset();
    useDeleteMemberMock.mockReset();
    invokeMock.mockReset();
  });

  it("renders the member name + summary copy + warning + step-1 input", () => {
    renderDialog({ transactionsCount: 3, cyclesCount: 2 });
    expect(screen.getByRole("heading", { level: 2, name: /awa diallo/i })).toBeInTheDocument();
    expect(
      screen.getByText(/3 transaction\(s\) sur 2 cycle\(s\) seront définitivement supprimés/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/cette action est définitive/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tapez SUPPRIMER pour confirmer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^continuer$/i })).toBeDisabled();
  });

  it("renders the zero-transactions copy when transactionsCount === 0", () => {
    renderDialog({ transactionsCount: 0, cyclesCount: 1 });
    expect(
      screen.getByText(/aucune transaction enregistrée\. 1 cycle\(s\) seront supprimés/i),
    ).toBeInTheDocument();
  });

  it("Continuer stays disabled until SUPPRIMER is typed (case-insensitive)", () => {
    renderDialog();
    const input = screen.getByLabelText(/tapez SUPPRIMER pour confirmer/i);
    fireEvent.change(input, { target: { value: "suppr" } });
    expect(screen.getByRole("button", { name: /^continuer$/i })).toBeDisabled();
    fireEvent.change(input, { target: { value: "supprimer" } }); // lowercase OK
    expect(screen.getByRole("button", { name: /^continuer$/i })).toBeEnabled();
  });

  it("advances to step 2 after Continuer is tapped", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/tapez SUPPRIMER pour confirmer/i), {
      target: { value: "SUPPRIMER" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continuer$/i }));
    expect(screen.getByLabelText(/confirmez votre mot de passe/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^supprimer définitivement$/i })).toBeDisabled();
  });

  it("on 401 from re-auth — clears password, shows alert, stays open", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { context: { status: 401 }, message: "Invalid password" },
    });
    const { onOpenChange } = renderDialog();
    fireEvent.change(screen.getByLabelText(/tapez SUPPRIMER pour confirmer/i), {
      target: { value: "SUPPRIMER" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continuer$/i }));
    fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^supprimer définitivement$/i }));

    await waitFor(() => expect(screen.getByText(/mot de passe invalide/i)).toBeInTheDocument());
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText(/confirmez votre mot de passe/i)).toHaveValue("");
  });

  it("on 429 from re-auth — shows rate-limited copy", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { context: { status: 429 }, message: "Rate limited" },
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText(/tapez SUPPRIMER pour confirmer/i), {
      target: { value: "SUPPRIMER" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continuer$/i }));
    fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
      target: { value: "anything" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^supprimer définitivement$/i }));
    await waitFor(() => expect(screen.getByText(/trop de tentatives/i)).toBeInTheDocument());
  });

  it("on re-auth 200 — fires the delete mutation + onSuccess + onOpenChange(false)", async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, scope: "member_delete" }, error: null });
    mutateAsyncMock.mockResolvedValue(undefined);
    const { onOpenChange, onSuccess } = renderDialog();
    fireEvent.change(screen.getByLabelText(/tapez SUPPRIMER pour confirmer/i), {
      target: { value: "SUPPRIMER" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continuer$/i }));
    fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
      target: { value: "real-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^supprimer définitivement$/i }));

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledWith(MEMBER_ID));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(MEMBER_ID));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on RPC failure post-re-auth — fires onMutationFailure, dialog stays open", async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, scope: "member_delete" }, error: null });
    mutateAsyncMock.mockRejectedValue(new Error("RPC failed"));
    const { onOpenChange, onMutationFailure, onSuccess } = renderDialog();
    fireEvent.change(screen.getByLabelText(/tapez SUPPRIMER pour confirmer/i), {
      target: { value: "SUPPRIMER" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^continuer$/i }));
    fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
      target: { value: "real-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^supprimer définitivement$/i }));

    await waitFor(() => expect(onMutationFailure).toHaveBeenCalled());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Annuler closes the dialog (step 1)", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^annuler$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
