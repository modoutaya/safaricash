// Story 2.4 — computeMemberStats unit tests.
import { describe, expect, it } from "vitest";

import { computeMemberStats } from "./computeMemberStats";
import type { TransactionRow } from "../types";

const makeTx = (overrides: Partial<TransactionRow>): TransactionRow => ({
  id: overrides.id ?? "tx-1",
  member_id: "m-1",
  cycle_id: "c-1",
  kind: overrides.kind ?? "contribution",
  amount: overrides.amount ?? 500,
  cycle_day: overrides.cycle_day ?? 1,
  created_at: overrides.created_at ?? "2026-04-22T09:00:00Z",
});

const TODAY = new Date("2026-04-22T12:00:00Z");
const CYCLE = { startDate: "2026-04-12" }; // 11 days ago → cycle day 11

describe("computeMemberStats", () => {
  it("returns zeros when no transactions and no current cycle", () => {
    const stats = computeMemberStats([], { dailyAmount: 500 }, null, TODAY);
    expect(stats).toEqual({
      cycleDay: 0,
      daysRemaining: 0,
      contributedTotal: 0,
      outstandingAdvances: 0,
      projectedFinalBalance: 0,
    });
  });

  it("contribution-only — sums into contributedTotal, projected = daily × 29", () => {
    const txs = [
      makeTx({ kind: "contribution", amount: 500 }),
      makeTx({ id: "tx-2", kind: "contribution", amount: 500 }),
    ];
    const stats = computeMemberStats(txs, { dailyAmount: 500 }, CYCLE, TODAY);
    expect(stats.contributedTotal).toBe(1000);
    expect(stats.outstandingAdvances).toBe(0);
    expect(stats.projectedFinalBalance).toBe(500 * 29); // 14500
  });

  it("contribution + rattrapage both count toward contributedTotal", () => {
    const txs = [
      makeTx({ kind: "contribution", amount: 500 }),
      makeTx({ id: "tx-2", kind: "rattrapage", amount: 1500 }),
    ];
    const stats = computeMemberStats(txs, { dailyAmount: 500 }, CYCLE, TODAY);
    expect(stats.contributedTotal).toBe(2000);
    expect(stats.outstandingAdvances).toBe(0);
  });

  it("advance-only — outstandingAdvances rises, projected drops by Σ", () => {
    const txs = [
      makeTx({ kind: "advance", amount: 3000 }),
      makeTx({ id: "tx-2", kind: "advance", amount: 2000 }),
    ];
    const stats = computeMemberStats(txs, { dailyAmount: 500 }, CYCLE, TODAY);
    expect(stats.contributedTotal).toBe(0);
    expect(stats.outstandingAdvances).toBe(5000);
    expect(stats.projectedFinalBalance).toBe(500 * 29 - 5000); // 9500
  });

  it("mixed — every kind contributes correctly", () => {
    const txs = [
      makeTx({ kind: "contribution", amount: 500 }),
      makeTx({ id: "tx-2", kind: "rattrapage", amount: 1000 }),
      makeTx({ id: "tx-3", kind: "advance", amount: 2000 }),
    ];
    const stats = computeMemberStats(txs, { dailyAmount: 500 }, CYCLE, TODAY);
    expect(stats.contributedTotal).toBe(1500);
    expect(stats.outstandingAdvances).toBe(2000);
    expect(stats.projectedFinalBalance).toBe(500 * 29 - 2000); // 12500
  });

  it("clamps cycleDay to a floor of 1 (cycle started in the future)", () => {
    const future = { startDate: "2026-05-01" };
    const stats = computeMemberStats([], { dailyAmount: 500 }, future, TODAY);
    expect(stats.cycleDay).toBe(1);
    expect(stats.daysRemaining).toBe(29);
  });

  it("clamps cycleDay to a ceiling of 30 (cycle started 60 days ago)", () => {
    const old = { startDate: "2026-02-22" };
    const stats = computeMemberStats([], { dailyAmount: 500 }, old, TODAY);
    expect(stats.cycleDay).toBe(30);
    expect(stats.daysRemaining).toBe(0);
  });

  it("FR17 worked example — daily 7500 × 22 days, 0 advances", () => {
    const txs = Array.from({ length: 22 }, (_, i) =>
      makeTx({ id: `tx-${i}`, kind: "contribution", amount: 7500 }),
    );
    const stats = computeMemberStats(txs, { dailyAmount: 7500 }, CYCLE, TODAY);
    expect(stats.contributedTotal).toBe(7500 * 22);
    expect(stats.projectedFinalBalance).toBe(7500 * 29);
  });

  it("FR17 worked example — advance reduces projected by exact amount", () => {
    const txs = [makeTx({ kind: "advance", amount: 75000 })];
    const stats = computeMemberStats(txs, { dailyAmount: 7500 }, CYCLE, TODAY);
    expect(stats.projectedFinalBalance).toBe(7500 * 29 - 75000); // 142500
  });
});
