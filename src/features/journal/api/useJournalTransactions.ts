// Story 12.1 — lazy fetch of one member's transactions for the selected
// period. Triggered when a JournalMemberSection is expanded.
//
// Reads `transactions_decrypted` (RLS-scoped, vault-decrypted) filtered by
// member + the period's [from, to] window. Per-member cache key so each
// expanded section's data lives independently.

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
}

const journalTxRowSchema = z.object({
  id: z.string().uuid(),
  kind: transactionKindSchema,
  amount: z.coerce.number().int(),
  created_at: z.string(),
});

export function journalTransactionsQueryKey(
  memberId: string,
  period: JournalPeriod,
  fromIso: string,
  toIso: string,
): ReadonlyArray<string> {
  // Include `fromIso` so a "last_two_days" window that crosses midnight
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
        .select("id, kind, amount, created_at")
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
      }));
    },
    staleTime: 30_000,
  });
}
