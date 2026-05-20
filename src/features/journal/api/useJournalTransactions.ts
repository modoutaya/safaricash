// Story 12.1 — lazy fetch of one member's transactions for the selected
// period. Triggered when a JournalMemberSection is expanded.
//
// Reads `transactions_decrypted` (RLS-scoped, vault-decrypted) filtered by
// member + the period's [from, to] window. Per-member cache key so each
// expanded section's data lives independently.
//
// Story 12.2 widened the SELECT to include `cycle_day`, `cycle_id`,
// `days_covered` — the calendar-view builder needs cycle-day for the
// missing-day calculation and days_covered for rattrapage suppression.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import { supabase } from "@/infrastructure/supabase/client";

import { transactionKindSchema } from "@/features/member";

import type { JournalPeriod } from "./period";

export interface JournalTransaction {
  id: string;
  kind: z.infer<typeof transactionKindSchema>;
  amount: number;
  createdAt: string;
  /** 1-indexed day within the cycle the transaction was recorded against.
   *  Used by Story 12.2's buildJournalDayRows for the missing-day fill. */
  cycleDay: number;
  /** The cycle row this transaction targets — used to disambiguate which
   *  cycle a calendar day in `last_seven_days` falls under. */
  cycleId: string;
  /** For `kind='rattrapage'` only: how many forward days the rattrapage
   *  covers (the SQL contract enforces `2 ≤ days_covered ≤ 4`). Other
   *  kinds null. Used by buildJournalDayRows to suppress the N−1 covered
   *  days from the calendar list. */
  daysCovered: number | null;
}

const journalTxRowSchema = z.object({
  id: z.string().uuid(),
  kind: transactionKindSchema,
  amount: z.coerce.number().int(),
  created_at: z.string(),
  cycle_day: z.number().int().min(1).max(31),
  cycle_id: z.string().uuid(),
  days_covered: z.number().int().nullable(),
});

export function journalTransactionsQueryKey(
  memberId: string,
  period: JournalPeriod,
  fromIso: string,
  toIso: string,
): ReadonlyArray<string> {
  // Include `fromIso` so a "last_seven_days" window that crosses midnight
  // doesn't stale-cache. cycle periods have stable bounds → reusing keys
  // is fine.
  return ["journal", "transactions", memberId, period, fromIso, toIso];
}

interface UseJournalTransactionsInput {
  memberId: string;
  period: JournalPeriod;
  /** Resolved [from, to] window for THIS member's period — null when the
   *  period doesn't apply (e.g. no previous cycle on file). */
  bounds: { fromIso: string; toIso: string } | null;
  /** Caller (the parent <details> open handler) flips this to true on
   *  expand. Keeps the fetch lazy. */
  enabled: boolean;
}

export function useJournalTransactions(
  input: UseJournalTransactionsInput,
): UseQueryResult<JournalTransaction[], Error> {
  const { memberId, period, bounds, enabled } = input;
  return useQuery({
    queryKey: bounds
      ? journalTransactionsQueryKey(memberId, period, bounds.fromIso, bounds.toIso)
      : ["journal", "transactions", memberId, period, "no-bounds"],
    enabled: enabled && bounds !== null,
    queryFn: async (): Promise<JournalTransaction[]> => {
      if (!bounds) return [];
      const { data, error } = await supabase
        .from("transactions_decrypted")
        .select("id, kind, amount, created_at, cycle_day, cycle_id, days_covered")
        .eq("member_id", memberId)
        .gte("created_at", bounds.fromIso)
        .lte("created_at", bounds.toIso)
        .order("created_at", { ascending: false });
      if (error) {
        throw new Error(`journal transactions query failed: ${error.message}`);
      }
      const parsed = z.array(journalTxRowSchema).parse(data ?? []);
      return parsed.map((row) => ({
        id: row.id,
        kind: row.kind,
        amount: row.amount,
        createdAt: row.created_at,
        cycleDay: row.cycle_day,
        cycleId: row.cycle_id,
        daysCovered: row.days_covered,
      }));
    },
    staleTime: 30_000,
  });
}
