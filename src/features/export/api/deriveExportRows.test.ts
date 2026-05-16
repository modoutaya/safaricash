// Story 9.3 — deriveExportRows tests.

import { describe, expect, it } from "vitest";

import {
  deriveCycleSummaryRows,
  deriveTransactionRows,
  type ExportCycle,
  type ExportMember,
  type ExportTransaction,
} from "./deriveExportRows";

const MEMBER: ExportMember = { id: "mem-1", name: "Awa Diop", daily_amount: 500 };

function cycle(overrides: Partial<ExportCycle> = {}): ExportCycle {
  return {
    id: "cyc-1",
    member_id: "mem-1",
    start_date: "2026-04-01",
    end_date: "2026-04-30",
    status: "active",
    ...overrides,
  };
}

function tx(overrides: Partial<ExportTransaction> = {}): ExportTransaction {
  return {
    id: crypto.randomUUID(),
    member_id: "mem-1",
    cycle_id: "cyc-1",
    kind: "contribution",
    amount: 500,
    created_at: "2026-04-05T08:00:00.000000Z",
    ...overrides,
  };
}

describe("deriveCycleSummaryRows", () => {
  it("empty cycles → empty rows", () => {
    expect(deriveCycleSummaryRows([], [MEMBER], [])).toEqual([]);
  });

  it("sums contribution + rattrapage into total_contributions, advances separately", () => {
    const rows = deriveCycleSummaryRows(
      [cycle()],
      [MEMBER],
      [
        tx({ kind: "contribution", amount: 500 }),
        tx({ kind: "rattrapage", amount: 1500 }),
        tx({ kind: "advance", amount: 3000 }),
      ],
    );
    expect(rows[0]!.total_contributions).toBe(2000);
    expect(rows[0]!.advances_sum).toBe(3000);
  });

  it("commission = commission(dailyAmount) from the cycle engine", () => {
    const rows = deriveCycleSummaryRows([cycle()], [MEMBER], []);
    // commission() = dailyAmount × 1.
    expect(rows[0]!.commission).toBe(500);
  });

  it("final_payout for a settled cycle = the settlement transaction's amount", () => {
    const rows = deriveCycleSummaryRows(
      [cycle({ status: "settled" })],
      [MEMBER],
      [tx({ kind: "settlement", amount: 13500 })],
    );
    expect(rows[0]!.final_payout).toBe(13500);
  });

  it("final_payout falls back to the projection when a settled cycle has no settlement tx", () => {
    const rows = deriveCycleSummaryRows([cycle({ status: "settled" })], [MEMBER], []);
    // computeProjectedFinalBalance(500, 0) = 500×29 = 14500.
    expect(rows[0]!.final_payout).toBe(14500);
  });

  it("final_payout for a non-settled cycle = projected balance (daily×29 − advances)", () => {
    const rows = deriveCycleSummaryRows(
      [cycle({ status: "with_advance" })],
      [MEMBER],
      [tx({ kind: "advance", amount: 2000 })],
    );
    // computeProjectedFinalBalance(500, 2000) = 500×29 − 2000 = 12500.
    expect(rows[0]!.final_payout).toBe(12500);
  });

  it("only the cycle's own transactions are aggregated", () => {
    const rows = deriveCycleSummaryRows(
      [cycle({ id: "cyc-1" })],
      [MEMBER],
      [
        tx({ cycle_id: "cyc-1", kind: "contribution", amount: 500 }),
        tx({ cycle_id: "cyc-OTHER", kind: "contribution", amount: 9999 }),
      ],
    );
    expect(rows[0]!.total_contributions).toBe(500);
  });

  it("final_payout for a completed (non-settled) cycle = the projection", () => {
    const rows = deriveCycleSummaryRows(
      [cycle({ status: "completed" })],
      [MEMBER],
      [tx({ kind: "advance", amount: 1000 })],
    );
    // computeProjectedFinalBalance(500, 1000) = 500×29 − 1000 = 13500.
    expect(rows[0]!.final_payout).toBe(13500);
  });

  it("carries cycle metadata + a member-name fallback when the member is absent", () => {
    const rows = deriveCycleSummaryRows([cycle({ status: "completed" })], [], []);
    expect(rows[0]).toMatchObject({
      cycle_id: "cyc-1",
      member_name: "",
      cycle_start_date: "2026-04-01",
      cycle_end_date: "2026-04-30",
      status: "completed",
    });
  });
});

describe("deriveTransactionRows", () => {
  it("maps each transaction to the export row shape with the member name", () => {
    const rows = deriveTransactionRows(
      [tx({ id: "tx-1", kind: "advance", amount: 7000, created_at: "2026-04-09T10:00:00Z" })],
      [MEMBER],
    );
    expect(rows[0]).toEqual({
      transaction_id: "tx-1",
      date: "2026-04-09T10:00:00Z",
      kind: "advance",
      amount: 7000,
      member_id: "mem-1",
      member_name: "Awa Diop",
    });
  });

  it("falls back to an empty member name when the member is absent", () => {
    const rows = deriveTransactionRows([tx({ member_id: "ghost" })], [MEMBER]);
    expect(rows[0]!.member_name).toBe("");
  });

  it("empty transactions → empty rows", () => {
    expect(deriveTransactionRows([], [MEMBER])).toEqual([]);
  });
});
