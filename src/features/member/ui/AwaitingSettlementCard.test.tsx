// Story 12.5 PR E — AwaitingSettlementCard component tests.
import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AwaitingSettlementCard } from "./AwaitingSettlementCard";

expect.extend(toHaveNoViolations);

function renderInRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("AwaitingSettlementCard", () => {
  it("renders the title, cycle-closed sub-label, amount, and CTA", () => {
    renderInRouter(
      <AwaitingSettlementCard
        payoutAmount={14_500}
        cycleEndDate="2026-04-30"
        settleHref="/members/abc/settlement"
      />,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: /Paiement en attente/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Cycle clos le 30 avril 2026/i)).toBeInTheDocument();
    expect(screen.getByText(/14[\s\u00a0]500 FCFA/)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /^payer le membre$/i });
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute("href", "/members/abc/settlement");
  });

  it("axe-clean across the default render", async () => {
    const { container } = renderInRouter(
      <AwaitingSettlementCard
        payoutAmount={59_000}
        cycleEndDate="2026-05-30"
        settleHref="/members/khadim/settlement"
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("formats a different cycle end date correctly (UTC midnight, fr-FR locale)", () => {
    renderInRouter(
      <AwaitingSettlementCard
        payoutAmount={1_000}
        cycleEndDate="2026-12-30"
        settleHref="/members/x/settlement"
      />,
    );
    expect(screen.getByText(/Cycle clos le 30 décembre 2026/i)).toBeInTheDocument();
  });
});
