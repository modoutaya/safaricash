// Story 2.4 — MemberProfile component tests.
import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

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
  daysRemaining: 19,
  contributedTotal: 5500,
  outstandingAdvances: 0,
  projectedFinalBalance: 14500,
};

const STATS_WITH_ADVANCES: MemberStats = {
  cycleDay: 11,
  daysRemaining: 19,
  contributedTotal: 5500,
  outstandingAdvances: 3000,
  projectedFinalBalance: 11500,
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
    expect(screen.getByText(/Versé/)).toBeInTheDocument();
    expect(screen.queryByText(/Avances en cours/)).not.toBeInTheDocument();
    expect(screen.getByText(/Solde prévu fin cycle/)).toBeInTheDocument();
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
});
