// Story 9.3 — CsvExportReauthDialog component tests.
// Mocks supabase.functions.invoke (re-auth), runCsvExport, and sonner.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(toHaveNoViolations);

const invokeMock = vi.fn();
const runCsvExportMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastWarningMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));

vi.mock("../api/runCsvExport", () => ({
  runCsvExport: () => runCsvExportMock(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

import { CsvExportReauthDialog } from "./CsvExportReauthDialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  invokeMock.mockReset();
  runCsvExportMock.mockReset();
  toastSuccessMock.mockReset();
  toastWarningMock.mockReset();
  toastErrorMock.mockReset();
});

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  const utils = render(<CsvExportReauthDialog open={open} onOpenChange={onOpenChange} />);
  return { ...utils, onOpenChange };
}

function submitPassword(value: string) {
  fireEvent.change(screen.getByLabelText(/confirmez votre mot de passe/i), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: /^exporter$/i }));
}

describe("CsvExportReauthDialog", () => {
  it("renders the title + password input", () => {
    renderDialog();
    expect(screen.getByRole("heading", { level: 2, name: /exporter en csv/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/confirmez votre mot de passe/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^exporter$/i })).toBeDisabled();
  });

  it("on 401 — shows invalid copy, does not export, stays open", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { context: { status: 401 }, message: "Invalid" },
    });
    const { onOpenChange } = renderDialog();
    submitPassword("wrong");

    await waitFor(() => expect(screen.getByText(/mot de passe invalide/i)).toBeInTheDocument());
    expect(runCsvExportMock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText(/confirmez votre mot de passe/i)).toHaveValue("");
  });

  it("on 429 — shows the rate-limited copy", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { context: { status: 429 }, message: "Rate limited" },
    });
    renderDialog();
    submitPassword("anything");
    await waitFor(() => expect(screen.getByText(/trop de tentatives/i)).toBeInTheDocument());
    expect(runCsvExportMock).not.toHaveBeenCalled();
  });

  it("on re-auth 200 — runs the export, toasts success, closes", async () => {
    invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
    runCsvExportMock.mockResolvedValue({
      cyclesCount: 2,
      transactionsCount: 9,
      auditFailed: false,
    });
    const { onOpenChange } = renderDialog();
    submitPassword("real-password");

    await waitFor(() => expect(runCsvExportMock).toHaveBeenCalled());
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on a failed audit — toasts a non-blocking warning, still closes", async () => {
    invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
    runCsvExportMock.mockResolvedValue({
      cyclesCount: 1,
      transactionsCount: 0,
      auditFailed: true,
    });
    const { onOpenChange } = renderDialog();
    submitPassword("real-password");

    await waitFor(() => expect(toastWarningMock).toHaveBeenCalled());
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on an export failure — toasts an error, stays open", async () => {
    invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
    runCsvExportMock.mockRejectedValue(new Error("fetch failed"));
    const { onOpenChange } = renderDialog();
    submitPassword("real-password");

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Annuler closes the dialog", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^annuler$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is axe-clean", async () => {
    const { container } = renderDialog();
    expect(await axe(container)).toHaveNoViolations();
  });
});
