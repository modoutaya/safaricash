// Story 7.1 — SettlementSummaryCard component tests.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { settle } from "@/domain/cycle";

import { SettlementSummaryCard } from "./SettlementSummaryCard";

expect.extend(toHaveNoViolations);

const baseProps = {
  memberId: "m-1",
  memberName: "Awa Diallo",
  dailyAmount: 500,
  contributedTotal: 14_000,
  advances: [3_000] as ReadonlyArray<number>,
  cycleId: "c-1",
  cycleStartDate: "2026-04-12",
  cycleEndDate: "2026-05-11",
  onVerifyTransactions: vi.fn(),
  onConfirm: vi.fn(),
};

describe("SettlementSummaryCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders header (avatar + h2 name + cycle range), 4 rows in order, and 2 CTAs", () => {
    const { container } = render(<SettlementSummaryCard {...baseProps} />);
    // Header: h2 with member name
    expect(screen.getByRole("heading", { level: 2, name: /Awa Diallo/ })).toBeInTheDocument();
    // Avatar initials — "Awa Diallo" → "AD"
    expect(screen.getByText("AD")).toBeInTheDocument();
    // Cycle range
    expect(screen.getByText(/Cycle du 12\/04\/2026 au 11\/05\/2026/)).toBeInTheDocument();
    // 4 rows: contributions / commission / advances / final payout
    expect(screen.getByText("Cotisations versées")).toBeInTheDocument();
    expect(screen.getByText("Commission collecteur")).toBeInTheDocument();
    expect(screen.getByText("Avances accordées")).toBeInTheDocument();
    expect(screen.getByText("Solde à remettre")).toBeInTheDocument();
    // 2 CTAs
    expect(screen.getByRole("button", { name: /Vérifier les transactions/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirmer le paiement/ })).toBeInTheDocument();
    // Component MUST NOT emit an h1 (AC #9)
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    // AC #1 — rows render in EXACT order: contributions → commission → advances → final payout.
    // Cross-check by scanning the rendered text top-to-bottom and asserting the label sequence.
    const fullText = container.textContent ?? "";
    const idxContrib = fullText.indexOf("Cotisations versées");
    const idxCommission = fullText.indexOf("Commission collecteur");
    const idxAdvances = fullText.indexOf("Avances accordées");
    const idxFinal = fullText.indexOf("Solde à remettre");
    expect(idxContrib).toBeGreaterThanOrEqual(0);
    expect(idxCommission).toBeGreaterThan(idxContrib);
    expect(idxAdvances).toBeGreaterThan(idxCommission);
    expect(idxFinal).toBeGreaterThan(idxAdvances);
  });

  it("math — final payout uses settle(dailyAmount, advances); dailyAmount=500, advances=[3000,2000] → 9 500 FCFA", () => {
    render(
      <SettlementSummaryCard
        {...baseProps}
        contributedTotal={14_500}
        dailyAmount={500}
        advances={[3_000, 2_000]}
      />,
    );
    // baseProps cycle 2026-04-12 → 2026-05-11 = 30 days → 29 contribution days.
    // settle(500, [3000, 2000], 29) = 500 * 29 − 5000 = 9500
    // Story 12.5 \u2014 settle(contributedTotal, daily, advances)
    expect(settle(14_500, 500, [3_000, 2_000])).toBe(9_000);
    expect(screen.getByText(/9[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("commission row uses commission(dailyAmount); dailyAmount=500 → − 500 FCFA", () => {
    render(<SettlementSummaryCard {...baseProps} dailyAmount={500} />);
    expect(screen.getByText(/− 500 FCFA/)).toBeInTheDocument();
  });

  it("empty advances — row 3 shows 'Aucune avance' + 0 FCFA, no sub-list", () => {
    render(<SettlementSummaryCard {...baseProps} advances={[]} />);
    expect(screen.getByText("Aucune avance")).toBeInTheDocument();
    expect(screen.getAllByText(/0 FCFA/).length).toBeGreaterThanOrEqual(1);
    // No sub-list items
    expect(screen.queryByText(/^Avance 1 :/)).not.toBeInTheDocument();
  });

  it("single advance — row 3 shows total, NO sub-list (per AC #1.3)", () => {
    render(<SettlementSummaryCard {...baseProps} advances={[3_000]} />);
    expect(screen.getByText(/− 3[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.queryByText(/^Avance 1 :/)).not.toBeInTheDocument();
  });

  it("multiple advances — row 3 shows sum + sub-list of each advance (array order)", () => {
    render(<SettlementSummaryCard {...baseProps} advances={[3_000, 2_000, 5_000]} />);
    expect(screen.getByText(/− 10[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/Avance 1 : 3[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/Avance 2 : 2[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/Avance 3 : 5[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("isSubmitting — both CTAs disabled; primary shows 'Paiement en cours…' + spinner", () => {
    render(<SettlementSummaryCard {...baseProps} isSubmitting />);
    const verify = screen.getByRole("button", { name: /Vérifier les transactions/ });
    expect(verify).toBeDisabled();
    // Primary label switches to submitting text
    const primary = screen.getByRole("button", { name: /Paiement en cours…/ });
    expect(primary).toBeDisabled();
    // Spinner icon — lucide Loader2 has aria-hidden and animate-spin class
    expect(primary.querySelector(".animate-spin")).not.toBeNull();
  });

  it("CTA callbacks fire with (memberId, cycleId)", () => {
    const onVerifyTransactions = vi.fn();
    const onConfirm = vi.fn();
    render(
      <SettlementSummaryCard
        {...baseProps}
        memberId="m-42"
        cycleId="c-99"
        onVerifyTransactions={onVerifyTransactions}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Vérifier les transactions/ }));
    expect(onVerifyTransactions).toHaveBeenCalledWith("m-42", "c-99");
    fireEvent.click(screen.getByRole("button", { name: /Confirmer le paiement/ }));
    expect(onConfirm).toHaveBeenCalledWith("m-42", "c-99");
  });

  it("aria-live='polite' is on the final-payout container only (no other live regions)", () => {
    const { container } = render(<SettlementSummaryCard {...baseProps} />);
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.textContent).toMatch(/Solde à remettre/);
  });

  it("cycle date range — YYYY-MM-DD props → DD/MM/YYYY fr-FR locale, UTC midnight to avoid tz drift", () => {
    render(
      <SettlementSummaryCard
        {...baseProps}
        cycleStartDate="2026-04-12"
        cycleEndDate="2026-05-11"
      />,
    );
    expect(screen.getByText("Cycle du 12/04/2026 au 11/05/2026")).toBeInTheDocument();
  });

  it("firstName subtitle — 'Awa Diallo' → 'à remettre à Awa'; single token 'Awa' → 'à remettre à Awa'", () => {
    const { rerender } = render(<SettlementSummaryCard {...baseProps} memberName="Awa Diallo" />);
    expect(screen.getByText(/à remettre à Awa$/)).toBeInTheDocument();
    rerender(<SettlementSummaryCard {...baseProps} memberName="Awa" />);
    expect(screen.getByText(/à remettre à Awa$/)).toBeInTheDocument();
  });

  it("contributedTotal renders as a positive number on row 1", () => {
    render(<SettlementSummaryCard {...baseProps} contributedTotal={14_000} />);
    // Row 1 should contain 14 000 FCFA (no minus prefix)
    const row1Label = screen.getByText("Cotisations versées");
    const row1 = row1Label.closest("div");
    expect(row1).not.toBeNull();
    expect(within(row1!).getByText(/14[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("axe-clean across preview and submitting states", async () => {
    const cases = [{ isSubmitting: false }, { isSubmitting: true }];
    for (const c of cases) {
      const { container, unmount } = render(
        <SettlementSummaryCard {...baseProps} isSubmitting={c.isSubmitting} />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
