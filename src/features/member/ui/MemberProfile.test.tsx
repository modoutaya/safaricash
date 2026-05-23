// Story 2.4 — MemberProfile component tests.
// Story 6.7 — added interactive-row regression (`onTransactionTap`).
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { MemberProfile } from "./MemberProfile";
import type { CycleRow, MemberRow, MemberStats, TransactionRow } from "../types";

expect.extend(toHaveNoViolations);

const MEMBER: MemberRow = {
  id: "11111111-1111-4111-8111-111111111111",
  collector_id: "00000000-0000-4000-8000-000000000001",
  name: "Awa Diallo",
  phone_number: "+221777915898",
  daily_amount: 500,
  status: "active",
  created_at: "2026-04-12T08:00:00Z",
  updated_at: "2026-04-12T08:00:00Z",
  sms_opt_out: false,
};

const CYCLE: CycleRow = {
  id: "22222222-2222-4222-8222-222222222222",
  cycle_number: 1,
  start_date: "2026-04-12",
  end_date: "2026-05-11",
  status: "active",
};

const STATS_NO_ADVANCES: MemberStats = {
  cycleDay: 11,
  cycleLength: 30,
  daysRemaining: 19,
  contributedTotal: 5500,
  outstandingAdvances: 0,
  openingBalance: 0,
  currentBalance: 14500,
};

const STATS_WITH_ADVANCES: MemberStats = {
  cycleDay: 11,
  cycleLength: 30,
  daysRemaining: 19,
  contributedTotal: 5500,
  outstandingAdvances: 3000,
  openingBalance: 0,
  currentBalance: 11500,
};

const txContrib: TransactionRow = {
  id: "33333333-3333-4333-8333-333333333333",
  member_id: MEMBER.id,
  cycle_id: CYCLE.id,
  kind: "contribution",
  amount: 500,
  cycle_day: 1,
  created_at: "2026-04-12T09:00:00Z",
};
const txAdvance: TransactionRow = {
  id: "44444444-4444-4444-8444-444444444444",
  member_id: MEMBER.id,
  cycle_id: CYCLE.id,
  kind: "advance",
  amount: 3000,
  cycle_day: 5,
  created_at: "2026-04-16T11:00:00Z",
};

describe("MemberProfile", () => {
  it("renders the 8 header datapoints (advances row hidden when 0)", () => {
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[txContrib]}
        stats={STATS_NO_ADVANCES}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: /awa diallo/i })).toBeInTheDocument();
    expect(screen.getByText("+221777915898")).toBeInTheDocument();
    expect(screen.getByText(/500 FCFA \/ jour/)).toBeInTheDocument();
    expect(screen.getByText(/Jour 11 sur 30/)).toBeInTheDocument();
    // Story 12.5 PR E — "Versé" → "Cotisé ce mois".
    expect(screen.getByText(/Cotisé ce mois/)).toBeInTheDocument();
    expect(screen.queryByText(/Avances en cours/)).not.toBeInTheDocument();
    expect(screen.getByText(/Solde à reverser/)).toBeInTheDocument();
  });

  it("renders the advances row when outstandingAdvances > 0", () => {
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[txContrib, txAdvance]}
        stats={STATS_WITH_ADVANCES}
      />,
    );
    expect(screen.getByText(/Avances en cours/)).toBeInTheDocument();
  });

  it("renders the empty-state copy when no transactions", () => {
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[]}
        stats={STATS_NO_ADVANCES}
      />,
    );
    expect(screen.getByText(/aucune transaction enregistrée/i)).toBeInTheDocument();
  });

  it("renders one transaction row per item with the right kind label", () => {
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[txContrib, txAdvance]}
        stats={STATS_WITH_ADVANCES}
      />,
    );
    expect(screen.getByText("Cotisation")).toBeInTheDocument();
    expect(screen.getByText("Avance")).toBeInTheDocument();
    // Cycle-day chips
    expect(screen.getByText("J1")).toBeInTheDocument();
    expect(screen.getByText("J5")).toBeInTheDocument();
  });

  it("hides the optional phone row when null", () => {
    const noPhone = { ...MEMBER, phone_number: null };
    render(
      <MemberProfile
        member={noPhone}
        currentCycle={CYCLE}
        transactions={[]}
        stats={STATS_NO_ADVANCES}
      />,
    );
    expect(screen.queryByText("+221777915898")).not.toBeInTheDocument();
  });

  it("Story 2.7 — does NOT render 'Cycles précédents' when previousCycles is empty", () => {
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[]}
        stats={STATS_NO_ADVANCES}
      />,
    );
    expect(
      screen.queryByRole("heading", { level: 2, name: /cycles précédents/i }),
    ).not.toBeInTheDocument();
  });

  it("Story 2.7 — renders 'Cycles précédents' with one row per previousCycle", () => {
    const previousCycles: CycleRow[] = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        cycle_number: 2,
        start_date: "2026-03-12",
        end_date: "2026-04-10",
        status: "completed",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        cycle_number: 1,
        start_date: "2026-02-12",
        end_date: "2026-03-13",
        status: "settled",
      },
    ];
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={{ ...CYCLE, cycle_number: 3 }}
        previousCycles={previousCycles}
        transactions={[]}
        stats={STATS_NO_ADVANCES}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 2, name: /cycles précédents/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Cycle 2 — du 12\/03\/2026 au 10\/04\/2026$/)).toBeInTheDocument();
    expect(screen.getByText(/^Cycle 1 — du 12\/02\/2026 au 13\/03\/2026$/)).toBeInTheDocument();
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[txContrib, txAdvance]}
        stats={STATS_WITH_ADVANCES}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Story 6.7 AC #21 — interactive rows when onTransactionTap is provided.
  it("Story 6.7 — renders transactions as <button> when onTransactionTap is provided", () => {
    const onTransactionTap = vi.fn();
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[txContrib]}
        stats={STATS_NO_ADVANCES}
        onTransactionTap={onTransactionTap}
      />,
    );
    const row = screen.getByRole("button", { name: /Voir le reçu de Cotisation/i });
    expect(row).toBeInTheDocument();
    expect(row.getAttribute("data-tx-id")).toBe(txContrib.id);
    fireEvent.click(row);
    expect(onTransactionTap).toHaveBeenCalledWith(txContrib);
  });

  it("Story 6.7 — keeps non-interactive rendering when onTransactionTap is undefined", () => {
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[txContrib]}
        stats={STATS_NO_ADVANCES}
      />,
    );
    expect(screen.queryByRole("button", { name: /Voir le reçu/i })).not.toBeInTheDocument();
  });

  it("Story 10.3 — no dispute banner + no row dispute icon when there are no disputes", () => {
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[txContrib]}
        stats={STATS_NO_ADVANCES}
      />,
    );
    expect(screen.queryByText("Transaction contestée")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Cette transaction est contestée")).not.toBeInTheDocument();
  });

  it("2026-05-23 — settled cycle: heading flips to 'Cycle réglé' and shows 'Reversé : X FCFA' (not the projected balance)", () => {
    const settledCycle: CycleRow = { ...CYCLE, status: "settled" };
    const txSettlement: TransactionRow = {
      id: "55555555-5555-4555-8555-555555555555",
      member_id: MEMBER.id,
      cycle_id: CYCLE.id,
      kind: "settlement",
      amount: 14_500,
      cycle_day: 30,
      created_at: "2026-05-12T10:00:00Z",
    };
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={settledCycle}
        transactions={[txContrib, txSettlement]}
        stats={STATS_NO_ADVANCES}
      />,
    );
    // Title flipped (past tense).
    expect(screen.getByRole("heading", { name: /^Cycle réglé/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Cycle en cours/i })).not.toBeInTheDocument();
    // Balance line shows the settlement amount, past tense.
    expect(screen.getByText(/Reversé\s*:\s*14\s500 FCFA/)).toBeInTheDocument();
    // The "Solde à reverser" forward-looking label must be GONE on a
    // settled cycle (this was the bug — same amount + misleading copy).
    expect(screen.queryByText(/Solde à reverser/)).not.toBeInTheDocument();
  });

  it("Story 10.3 — shows the dispute banner + a per-row dispute icon for disputed transactions", () => {
    const onDisputeBannerTap = vi.fn();
    render(
      <MemberProfile
        member={MEMBER}
        currentCycle={CYCLE}
        transactions={[txContrib, txAdvance]}
        stats={STATS_NO_ADVANCES}
        openDisputeCount={1}
        disputedTransactionIds={new Set([txContrib.id])}
        onDisputeBannerTap={onDisputeBannerTap}
      />,
    );
    // Banner.
    expect(screen.getByText("Transaction contestée")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /voir le détail/i }));
    expect(onDisputeBannerTap).toHaveBeenCalledTimes(1);
    // Exactly the disputed transaction row carries the icon.
    expect(screen.getByLabelText("Cette transaction est contestée")).toBeInTheDocument();
  });
});
