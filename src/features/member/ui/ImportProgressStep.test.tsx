// Story 2.3 — ImportProgressStep tests.
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImportProgressStep } from "./ImportProgressStep";
import type { ImportRowResult, ImportSummary } from "../api/useImportMembers";
import type { PickedContact } from "./ContactsPickerStep";

const CONTACTS: PickedContact[] = [
  { id: "1", name: "Awa", phone: "+221777915898" },
  { id: "2", name: "Bah", phone: "" },
];

const summaryOf = (ok: number, failed: number, pending: number, total: number): ImportSummary => ({
  ok,
  failed,
  pending,
  total,
});

describe("ImportProgressStep", () => {
  it("renders the progress summary line", () => {
    render(
      <ImportProgressStep
        contacts={CONTACTS}
        results={new Map()}
        summary={summaryOf(0, 0, 2, 2)}
        isRunning={true}
        onRetryFailed={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/0 membres ajoutés.*0 échoués.*2/)).toBeInTheDocument();
  });

  it("renders ✓ status for ok rows + retry CTA when failures exist", () => {
    const results = new Map<number, ImportRowResult>([
      [0, { status: "ok", memberId: "m-1" }],
      [1, { status: "error", code: "duplicate_phone", message: "23505" }],
    ]);
    const onRetry = vi.fn();
    render(
      <ImportProgressStep
        contacts={CONTACTS}
        results={results}
        summary={summaryOf(1, 1, 0, 2)}
        isRunning={false}
        onRetryFailed={onRetry}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/Ajouté/)).toBeInTheDocument();
    expect(screen.getByText(/Un membre avec ce numéro existe déjà/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /réessayer les échoués \(1\)/i });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalled();
  });

  it("hides the retry CTA when no failures", () => {
    const results = new Map<number, ImportRowResult>([
      [0, { status: "ok", memberId: "m-1" }],
      [1, { status: "ok", memberId: "m-2" }],
    ]);
    render(
      <ImportProgressStep
        contacts={CONTACTS}
        results={results}
        summary={summaryOf(2, 0, 0, 2)}
        isRunning={false}
        onRetryFailed={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /réessayer/i })).not.toBeInTheDocument();
  });
});
