// Story 2.7 — RestartCycleDialog component tests.
// Mocks useRestartCycle to focus on the dialog's interaction contract.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutateAsyncMock = vi.fn();
const resetMock = vi.fn();
const useRestartCycleMock = vi.fn();

vi.mock("../api/useRestartCycle", () => ({
  useRestartCycle: () => useRestartCycleMock(),
}));

import { RestartCycleDialog } from "./RestartCycleDialog";

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";

// jsdom doesn't implement <dialog>'s showModal/close natively. Stub them
// at the prototype level so the useEffect open/close calls don't throw.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function renderDialog(overrides: Partial<{ open: boolean; error: { code: string } | null }> = {}) {
  const onOpenChange = vi.fn();
  const onSuccess = vi.fn();
  useRestartCycleMock.mockReturnValue({
    isPending: false,
    error: overrides.error ?? null,
    mutateAsync: mutateAsyncMock,
    reset: resetMock,
  });
  const utils = render(
    <RestartCycleDialog
      open={overrides.open ?? true}
      onOpenChange={onOpenChange}
      memberId={MEMBER_ID}
      memberName="Awa Diallo"
      onSuccess={onSuccess}
    />,
  );
  return { ...utils, onOpenChange, onSuccess };
}

describe("RestartCycleDialog", () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    resetMock.mockReset();
    useRestartCycleMock.mockReset();
  });

  it("renders title + body + 2 CTAs when open", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { level: 2, name: /redémarrer le cycle ?/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/awa diallo/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^redémarrer$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^annuler$/i })).toBeInTheDocument();
  });

  it("Annuler closes via onOpenChange(false) without calling the mutation", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^annuler$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it("Redémarrer fires the mutation, calls onSuccess + onOpenChange(false) on resolve", async () => {
    mutateAsyncMock.mockResolvedValue("99999999-9999-4999-8999-999999999999");
    const { onOpenChange, onSuccess } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^redémarrer$/i }));

    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledWith(MEMBER_ID));
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith("99999999-9999-4999-8999-999999999999"),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the error copy + stays open when the mutation rejects", () => {
    renderDialog({ error: { code: "not_restartable" } });
    expect(screen.getByText(/le cycle est de nouveau actif/i)).toBeInTheDocument();
  });
});
