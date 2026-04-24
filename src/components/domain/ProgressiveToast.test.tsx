// Story 4.2 — ProgressiveToast component tests.
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { ProgressiveToast, type ProgressiveToastState } from "./ProgressiveToast";

expect.extend(toHaveNoViolations);

const NAME = "Awa Diallo";

describe("ProgressiveToast", () => {
  it("renders 'just-committed' with countdown + Annuler button", () => {
    const onUndo = vi.fn();
    render(
      <ProgressiveToast
        state={{ kind: "just-committed", secondsLeft: 5, memberName: NAME }}
        onUndo={onUndo}
      />,
    );
    expect(screen.getByText(/cotisation enregistrée — awa diallo/i)).toBeInTheDocument();
    const annuler = screen.getByRole("button", { name: /annuler \(5s\)/i });
    fireEvent.click(annuler);
    expect(onUndo).toHaveBeenCalled();
  });

  it("renders 'sending' state with spinner + member name", () => {
    const { container } = render(
      <ProgressiveToast state={{ kind: "sending", memberName: NAME }} />,
    );
    expect(screen.getByText(/envoi du reçu à awa diallo/i)).toBeInTheDocument();
    // Spinner is aria-hidden, so query by class.
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("renders 'delivered' state", () => {
    render(<ProgressiveToast state={{ kind: "delivered", memberName: NAME }} />);
    expect(screen.getByText(/reçu délivré ✓ — awa diallo/i)).toBeInTheDocument();
  });

  it("renders 'offline' state with the warning copy", () => {
    render(<ProgressiveToast state={{ kind: "offline", memberName: NAME }} />);
    expect(screen.getByText(/hors-ligne — envoi au prochain réseau/i)).toBeInTheDocument();
  });

  it("renders 'failed' state with role=alert + Retenter button", () => {
    const onRetry = vi.fn();
    render(<ProgressiveToast state={{ kind: "failed", memberName: NAME }} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/échec de l'envoi — retenter/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retenter/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("uses role=status for non-failed states", () => {
    render(<ProgressiveToast state={{ kind: "delivered", memberName: NAME }} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("dismiss button calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <ProgressiveToast state={{ kind: "delivered", memberName: NAME }} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /fermer la notification/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("does NOT render Annuler when onUndo is omitted", () => {
    render(
      <ProgressiveToast state={{ kind: "just-committed", secondsLeft: 5, memberName: NAME }} />,
    );
    expect(screen.queryByRole("button", { name: /annuler/i })).not.toBeInTheDocument();
  });

  it("has no axe-detectable a11y violations across all 5 states", async () => {
    const states: ProgressiveToastState[] = [
      { kind: "just-committed", secondsLeft: 5, memberName: NAME },
      { kind: "sending", memberName: NAME },
      { kind: "delivered", memberName: NAME },
      { kind: "offline", memberName: NAME },
      { kind: "failed", memberName: NAME },
    ];
    for (const state of states) {
      const { container, unmount } = render(
        <ProgressiveToast state={state} onUndo={vi.fn()} onRetry={vi.fn()} onDismiss={vi.fn()} />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
