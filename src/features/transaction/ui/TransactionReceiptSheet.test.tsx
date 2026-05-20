// Story 6.7 — TransactionReceiptSheet component tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TransactionRow } from "@/features/member";

import { TransactionReceiptSheet } from "./TransactionReceiptSheet";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const BASE_TX: TransactionRow = {
  id: "11111111-1111-4111-8111-111111111111",
  member_id: "22222222-2222-4222-8222-222222222222",
  cycle_id: "33333333-3333-4333-8333-333333333333",
  kind: "contribution",
  amount: 500,
  cycle_day: 3,
  created_at: "2026-05-12T09:30:00Z",
  receipt_token: "a".repeat(32),
};

function renderSheet(
  overrides: Partial<{
    phone: string | null;
    smsOptOut: boolean;
    tx: TransactionRow;
  }> = {},
) {
  const onShare = vi.fn();
  const onResend = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <TransactionReceiptSheet
      open
      onOpenChange={onOpenChange}
      transaction={overrides.tx ?? BASE_TX}
      member={{
        phone_number: overrides.phone === undefined ? "+221770000111" : overrides.phone,
        sms_opt_out: overrides.smsOptOut ?? false,
      }}
      cycle={{ cycle_number: 7, cycle_length: 30 }}
      onShare={onShare}
      onResend={onResend}
    />,
  );
  return { ...utils, onShare, onResend, onOpenChange };
}

describe("TransactionReceiptSheet", () => {
  it("renders title + 4 detail rows + 2 action buttons", () => {
    renderSheet();
    expect(
      screen.getByRole("heading", { level: 2, name: /reçu de la transaction/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/cotisation/i)).toBeInTheDocument();
    expect(screen.getByText(/500 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/Jour 3 sur 30 — Cycle 7/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /partager le reçu/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /renvoyer par SMS/i })).toBeEnabled();
  });

  it("share button fires onShare", () => {
    const { onShare } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /partager le reçu/i }));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it("resend button fires onResend", () => {
    const { onResend } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /renvoyer par SMS/i }));
    expect(onResend).toHaveBeenCalledTimes(1);
  });

  it("resend disabled with caption when phone_number is null", () => {
    renderSheet({ phone: null });
    const resend = screen.getByRole("button", { name: /renvoyer par SMS/i });
    expect(resend).toBeDisabled();
    expect(screen.getAllByText(/aucun téléphone enregistré/i).length).toBeGreaterThan(0);
  });

  it("resend disabled with caption when sms_opt_out is true", () => {
    renderSheet({ smsOptOut: true });
    const resend = screen.getByRole("button", { name: /renvoyer par SMS/i });
    expect(resend).toBeDisabled();
    expect(screen.getAllByText(/le saver a refusé les SMS/i).length).toBeGreaterThan(0);
  });

  it("no-phone reason takes precedence over opt-out when both apply", () => {
    renderSheet({ phone: null, smsOptOut: true });
    expect(screen.getAllByText(/aucun téléphone enregistré/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/le saver a refusé les SMS/i)).not.toBeInTheDocument();
  });

  it("close button fires onOpenChange(false)", () => {
    const { onOpenChange } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /fermer/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders advance kind with leading minus prefix", () => {
    renderSheet({
      tx: { ...BASE_TX, kind: "advance" },
    });
    expect(screen.getByText(/avance/i)).toBeInTheDocument();
    expect(screen.getByText(/−500 FCFA/)).toBeInTheDocument();
  });
});
