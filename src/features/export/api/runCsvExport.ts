// Story 9.3 / FR37 — CSV export orchestration.
//
// Runs AFTER a successful password re-auth (the dialog's job): fetches the
// collector's cycles + members + transactions (RLS-scoped, decrypted
// views), derives the two CSV datasets, triggers two browser downloads,
// and records a best-effort `export.csv_generated` audit event.

import { z } from "zod";

import { supabase } from "@/infrastructure/supabase/client";

import { toCsv, triggerCsvDownload } from "./buildCsv";
import {
  deriveCycleSummaryRows,
  deriveTransactionRows,
  type ExportCycle,
  type ExportMember,
  type ExportTransaction,
} from "./deriveExportRows";

const cycleSchema = z.object({
  id: z.string(),
  member_id: z.string(),
  cycle_number: z.number().int().positive(),
  start_date: z.string(),
  end_date: z.string(),
  // Story 12.3 — typed enum (was `z.string()` pre-12.3). The export
  // now passes the value to computeOpeningBalance which expects the
  // narrow union.
  status: z.enum(["active", "with_advance", "completed", "settled"]),
});
const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
  daily_amount: z.coerce.number(),
});
const txSchema = z.object({
  id: z.string(),
  member_id: z.string(),
  cycle_id: z.string(),
  kind: z.string(),
  amount: z.coerce.number(),
  created_at: z.string(),
});

const CYCLE_HEADERS = [
  "cycle_id",
  "member_name",
  "cycle_start_date",
  "cycle_end_date",
  "total_contributions",
  "advances_sum",
  "commission",
  "final_payout",
  "status",
] as const;

const TX_HEADERS = [
  "transaction_id",
  "date",
  "kind",
  "amount",
  "member_id",
  "member_name",
] as const;

export interface CsvExportResult {
  cyclesCount: number;
  transactionsCount: number;
  /** True when the audit event could not be recorded — the CSVs still
   *  downloaded; the caller surfaces a non-blocking warning. */
  auditFailed: boolean;
}

export async function runCsvExport(): Promise<CsvExportResult> {
  const [cyclesResult, membersResult, txResult] = await Promise.all([
    supabase.from("cycles").select("id, member_id, cycle_number, start_date, end_date, status"),
    supabase.from("members_decrypted").select("id, name, daily_amount"),
    supabase
      .from("transactions_decrypted")
      .select("id, member_id, cycle_id, kind, amount, created_at"),
  ]);

  if (cyclesResult.error) {
    throw new Error(`export cycles query failed: ${cyclesResult.error.message}`);
  }
  if (membersResult.error) {
    throw new Error(`export members query failed: ${membersResult.error.message}`);
  }
  if (txResult.error) {
    throw new Error(`export transactions query failed: ${txResult.error.message}`);
  }

  const cycles: ExportCycle[] = z.array(cycleSchema).parse(cyclesResult.data ?? []);
  const members: ExportMember[] = z.array(memberSchema).parse(membersResult.data ?? []);
  const transactions: ExportTransaction[] = z.array(txSchema).parse(txResult.data ?? []);

  const cycleRows = deriveCycleSummaryRows(cycles, members, transactions);
  const txRows = deriveTransactionRows(transactions, members);

  const today = new Date().toISOString().slice(0, 10);
  triggerCsvDownload(
    `safaricash-cycles-${today}.csv`,
    toCsv(
      CYCLE_HEADERS,
      cycleRows.map((r) => [
        r.cycle_id,
        r.member_name,
        r.cycle_start_date,
        r.cycle_end_date,
        r.total_contributions,
        r.advances_sum,
        r.commission,
        r.final_payout,
        r.status,
      ]),
    ),
  );
  triggerCsvDownload(
    `safaricash-transactions-${today}.csv`,
    toCsv(
      TX_HEADERS,
      txRows.map((r) => [r.transaction_id, r.date, r.kind, r.amount, r.member_id, r.member_name]),
    ),
  );

  // Best-effort audit — the CSVs have already downloaded, so a failure
  // here must NOT present the export as failed (just a warning upstream).
  let auditFailed = false;
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const collectorId = sessionData.session?.user.id ?? null;
    if (!collectorId) {
      auditFailed = true;
    } else {
      const { error } = await supabase.rpc("audit_append_external", {
        p_event_type: "export.csv_generated",
        p_entity_id: collectorId,
        p_entity_table: "users",
        p_payload: { cycles_count: cycleRows.length, transactions_count: txRows.length },
      });
      if (error) auditFailed = true;
    }
  } catch {
    auditFailed = true;
  }

  return {
    cyclesCount: cycleRows.length,
    transactionsCount: txRows.length,
    auditFailed,
  };
}
