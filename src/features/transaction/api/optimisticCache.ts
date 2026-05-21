// Story 8.3 / FR40 — TanStack Query cache optimistic-update helpers for
// the 3 record-* mutations.
//
// Two surfaces are updated synchronously in onMutate so the UI reflects
// the just-recorded transaction across navigation (per BDD: "navigate to
// another member and back, the just-committed transaction is persisted
// in the local read-model"):
//
//   1. MEMBERS_QUERY_KEY (the recency-sorted list) — bump
//      latestInteractionAt, move the member to index 0.
//   2. MEMBER_PROFILE_QUERY_KEY for the affected member — synthesise a
//      transaction row + bump totalTransactionsCount + recompute
//      MemberStats (contributedTotal, outstandingAdvances, projected
//      balance) so the cycle progress UI reflects the new transaction
//      immediately while offline. Story 8.4's reconciler refetches on
//      successful replay, restoring server-truth.
//
// The helpers return the captured snapshots so onError can restore them
// on non-offline failures (cycle_closed / validation / unauthorized).

import type { QueryClient } from "@tanstack/react-query";

import { computeMemberStats } from "@/domain/cycle";
import {
  MEMBERS_QUERY_KEY,
  MEMBER_PROFILE_QUERY_KEY,
  type MemberProfileData,
  type MemberWithMeta,
  type TransactionKind,
  type TransactionRow,
} from "@/features/member";

export interface OptimisticUpdateInput {
  memberId: string;
  cycleId: string;
  /** Pre-generated synthetic transaction ID — MUST match the one passed
   *  to `appendEvent` so the optimistic row and the persisted offline
   *  event share an identifier. Generate in the hook's `onMutate` and
   *  read from the syntheticTxIdRef in `mutationFn` to keep them in
   *  lockstep (per Story 8.3 code-review patch on UUID mismatch). */
  syntheticTxId: string;
  kind: TransactionKind;
  amount: number;
  cycleDay: number;
}

export interface OptimisticSnapshots {
  previousMembers: MemberWithMeta[] | undefined;
  previousProfile: MemberProfileData | undefined;
}

/** Apply the optimistic cache updates and return the pre-update snapshots
 *  for `onError` rollback. Safe to call when caches are empty — the
 *  snapshot is just `undefined` in that case. */
export function applyOptimisticTransactionUpdate(
  queryClient: QueryClient,
  input: OptimisticUpdateInput,
): OptimisticSnapshots {
  const previousMembers = queryClient.getQueryData<MemberWithMeta[]>([...MEMBERS_QUERY_KEY]);
  const previousProfile = queryClient.getQueryData<MemberProfileData>([
    ...MEMBER_PROFILE_QUERY_KEY,
    input.memberId,
  ]);

  const now = new Date().toISOString();

  // 1. List update — bump latestInteractionAt + move to top.
  if (previousMembers) {
    const target = previousMembers.find((m) => m.id === input.memberId);
    if (target) {
      const updated: MemberWithMeta = { ...target, latestInteractionAt: now };
      const rest = previousMembers.filter((m) => m.id !== input.memberId);
      queryClient.setQueryData<MemberWithMeta[]>([...MEMBERS_QUERY_KEY], [updated, ...rest]);
    }
  }

  // 2. Profile update — synthesise a transaction row + bump counter +
  //    recompute stats so the cycle progress reflects the new tx.
  if (previousProfile) {
    const syntheticTx: TransactionRow = {
      id: input.syntheticTxId,
      member_id: input.memberId,
      cycle_id: input.cycleId,
      kind: input.kind,
      amount: input.amount,
      cycle_day: input.cycleDay,
      created_at: now,
      // receipt_token is server-generated; absent on the offline path.
    };
    const nextTransactions = [...previousProfile.transactions, syntheticTx];
    // Recompute stats (Story 8.3 patch — was a deferred gap in the
    // first pass). computeMemberStats is pure + cheap; runs over the
    // current-cycle transactions only (matches useMemberProfile's
    // filter semantics).
    // Story 12.3 — preserve the existing openingBalance from the cached
    // stats. A new transaction in the CURRENT cycle does NOT change the
    // carry-over (which is a snapshot of the PREVIOUS cycle's debt);
    // useMemberProfile's next refetch will re-derive the authoritative
    // value if anything has changed on the server.
    const nextStats = computeMemberStats(
      nextTransactions,
      { dailyAmount: previousProfile.member.daily_amount },
      previousProfile.currentCycle
        ? {
            startDate: previousProfile.currentCycle.start_date,
            endDate: previousProfile.currentCycle.end_date,
          }
        : null,
      undefined,
      previousProfile.stats.openingBalance,
    );
    const nextProfile: MemberProfileData = {
      ...previousProfile,
      transactions: nextTransactions,
      totalTransactionsCount: previousProfile.totalTransactionsCount + 1,
      stats: nextStats,
    };
    queryClient.setQueryData<MemberProfileData>(
      [...MEMBER_PROFILE_QUERY_KEY, input.memberId],
      nextProfile,
    );
  }

  return { previousMembers, previousProfile };
}

/** Restore both caches from the captured snapshots. Called from `onError`
 *  on non-offline failures (cycle_closed / validation / unauthorized). */
export function rollbackOptimisticTransactionUpdate(
  queryClient: QueryClient,
  memberId: string,
  snapshots: OptimisticSnapshots,
): void {
  if (snapshots.previousMembers !== undefined) {
    queryClient.setQueryData([...MEMBERS_QUERY_KEY], snapshots.previousMembers);
  }
  if (snapshots.previousProfile !== undefined) {
    queryClient.setQueryData([...MEMBER_PROFILE_QUERY_KEY, memberId], snapshots.previousProfile);
  }
}

/** Cancel any in-flight queries that would race the optimistic write.
 *  Story 8.3 patch — previous version only cancelled MEMBERS_QUERY_KEY
 *  which let a profile-refetch overwrite the optimistic synthetic row. */
export async function cancelOptimisticQueries(
  queryClient: QueryClient,
  memberId: string,
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: MEMBERS_QUERY_KEY }),
    queryClient.cancelQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, memberId] }),
  ]);
}
