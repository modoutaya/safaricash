// Story 9.3 / FR37 — pure derivation of the two CSV export datasets.
//
// Kept pure + caller-fed (no network) so the per-cycle aggregation is
// unit-tested on its own. `commission` / `computeProjectedFinalBalance`
// come from the cycle-engine domain — never re-derived inline.

import { commission, computeProjectedFinalBalance } from "@/domain/cycle";

/** Subset of a `cycles` row the export needs.
 *  Note: `cycles` has NO `settled_payout` column — the realised payout of
 *  a settled cycle is the amount of its synthetic `kind='settlement'`
 *  transaction (migration 0064 commit_cycle_settlement). */
export interface ExportCycle {
  id: string;
  member_id: string;
  start_date: string;
  end_date: string;
  status: string;
}

/** Subset of a `members_decrypted` row the export needs. */
export interface ExportMember {
  id: string;
  name: string;
  daily_amount: number;
}

/** Subset of a `transactions_decrypted` row the export needs. */
export interface ExportTransaction {
  id: string;
  member_id: string;
  cycle_id: string;
  kind: string;
  amount: number;
  created_at: string;
}

export interface CycleSummaryRow {
  cycle_id: string;
  member_name: string;
  cycle_start_date: string;
  cycle_end_date: string;
  total_contributions: number;
  advances_sum: number;
  commission: number;
  final_payout: number;
  status: string;
}

export interface TransactionExportRow {
  transaction_id: string;
  date: string;
  kind: string;
  amount: number;
  member_id: string;
  member_name: string;
}

const COLLECTED_KINDS = new Set(["contribution", "rattrapage"]);

/** One summary row per cycle (every status). `final_payout` is the real
 *  `settled_payout` for a settled cycle, else the projected balance. */
export function deriveCycleSummaryRows(
  cycles: readonly ExportCycle[],
  members: readonly ExportMember[],
  transactions: readonly ExportTransaction[],
): CycleSummaryRow[] {
  const memberById = new Map(members.map((m) => [m.id, m]));

  return cycles.map((cycle) => {
    const member = memberById.get(cycle.member_id);
    const dailyAmount = member?.daily_amount ?? 0;
    const cycleTx = transactions.filter((t) => t.cycle_id === cycle.id);

    const total_contributions = cycleTx
      .filter((t) => COLLECTED_KINDS.has(t.kind))
      .reduce((sum, t) => sum + t.amount, 0);
    const advances_sum = cycleTx
      .filter((t) => t.kind === "advance")
      .reduce((sum, t) => sum + t.amount, 0);

    // A settled cycle's realised payout is the amount of its synthetic
    // `settlement` transaction; a non-settled cycle has only a projection.
    const settledPayout = cycleTx.find((t) => t.kind === "settlement")?.amount ?? null;
    const final_payout =
      cycle.status === "settled" && settledPayout !== null
        ? settledPayout
        : computeProjectedFinalBalance(dailyAmount, advances_sum);

    return {
      cycle_id: cycle.id,
      member_name: member?.name ?? "",
      cycle_start_date: cycle.start_date,
      cycle_end_date: cycle.end_date,
      total_contributions,
      advances_sum,
      commission: commission(dailyAmount),
      final_payout,
      status: cycle.status,
    };
  });
}

/** One row per (non-undone — the view excludes undone) transaction. */
export function deriveTransactionRows(
  transactions: readonly ExportTransaction[],
  members: readonly ExportMember[],
): TransactionExportRow[] {
  const memberById = new Map(members.map((m) => [m.id, m]));
  return transactions.map((t) => ({
    transaction_id: t.id,
    date: t.created_at,
    kind: t.kind,
    amount: t.amount,
    member_id: t.member_id,
    member_name: memberById.get(t.member_id)?.name ?? "",
  }));
}
