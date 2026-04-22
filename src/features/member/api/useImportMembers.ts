// Story 2.3 — useImportMembers hook.
//
// Orchestrates N parallel calls to `create_member_with_cycle` (the same
// SECURITY DEFINER RPC used by Story 2.2's manual flow) with a 5-slot
// concurrency limiter. Uses Promise.allSettled so partial failure is
// visible per-row instead of aborting the batch on first rejection.
// `retryFailed()` re-fires only rows that previously errored.

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";

import { MEMBERS_QUERY_KEY, createMemberInputSchema, type CreateMemberInput } from "../types";
import { type CreateMemberErrorCode } from "./useCreateMember";

/** One row of the import set, post-validation. */
export type ImportRow = CreateMemberInput;

/** Per-row state machine. `pending` until the RPC settles, then `ok` with
 *  the new member id OR `error` with a typed code the UI can translate. */
export type ImportRowResult =
  | { status: "pending" }
  | { status: "ok"; memberId: string }
  | { status: "error"; code: CreateMemberErrorCode; message: string };

export interface ImportSummary {
  total: number;
  pending: number;
  ok: number;
  failed: number;
}

const MAX_IMPORT_CONCURRENCY = 5;

function classifyError(err: PostgrestError | { message?: string } | null): CreateMemberErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("auth_required")) return "unauthorized";
  if ("code" in err && err.code === "42501") return "unauthorized";
  if ("code" in err && err.code === "23505") return "duplicate_phone";
  if (msg.includes("invalid_name") || msg.includes("invalid_amount")) return "validation";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

function summarize(results: Map<number, ImportRowResult>, total: number): ImportSummary {
  let ok = 0;
  let failed = 0;
  let pending = 0;
  for (const r of results.values()) {
    if (r.status === "ok") ok += 1;
    else if (r.status === "error") failed += 1;
    else pending += 1;
  }
  pending += total - results.size;
  return { total, ok, failed, pending };
}

/** Run the given async tasks with at most `limit` running at the same time.
 *  Settles all (Promise.allSettled semantics) — never aborts on first
 *  rejection. `onSettle` fires once per task with the original task index. */
async function runWithConcurrency<T>(
  tasks: Array<{ index: number; fn: () => Promise<T> }>,
  limit: number,
  onSettle: (originalIndex: number, result: T | { error: unknown }) => void,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const myCursor = cursor;
      cursor += 1;
      const job = tasks[myCursor];
      if (!job) continue; // noUncheckedIndexedAccess — race-impossible but TS demands it
      try {
        const value = await job.fn();
        onSettle(job.index, value);
      } catch (err) {
        onSettle(job.index, { error: err });
      }
    }
  }
  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export interface UseImportMembersReturn {
  start: (rows: ImportRow[]) => Promise<void>;
  retryFailed: () => Promise<void>;
  results: Map<number, ImportRowResult>;
  summary: ImportSummary;
  isRunning: boolean;
}

export function useImportMembers(): UseImportMembersReturn {
  const queryClient = useQueryClient();
  const [results, setResults] = useState<Map<number, ImportRowResult>>(new Map());
  const [isRunning, setIsRunning] = useState(false);
  // Total tracked as state so the summary closure (computed during render)
  // doesn't read the rows ref directly — the react-hooks/refs lint rule
  // disallows reading refs at render time.
  const [total, setTotal] = useState(0);
  const lastRowsRef = useRef<ImportRow[]>([]);

  const runBatch = useCallback(
    async (rows: ImportRow[], indices: number[]): Promise<void> => {
      lastRowsRef.current = rows;
      setTotal(rows.length);
      setIsRunning(true);
      setResults((prev) => {
        const next = new Map(prev);
        for (const i of indices) next.set(i, { status: "pending" });
        return next;
      });

      const tasks = indices.map((index) => ({
        index,
        fn: async (): Promise<{ memberId: string }> => {
          const row = createMemberInputSchema.parse(rows[index]);
          const { data, error } = await supabase.rpc("create_member_with_cycle", {
            p_name: row.name,
            p_phone_number: row.phoneNumber,
            p_daily_amount: row.dailyAmount,
            p_created_via: "contacts_import",
          });
          if (error) throw error;
          if (typeof data !== "string") throw new Error("RPC returned no member id");
          return { memberId: data };
        },
      }));

      await runWithConcurrency(tasks, MAX_IMPORT_CONCURRENCY, (originalIndex, outcome) => {
        setResults((prev) => {
          const next = new Map(prev);
          if (outcome && typeof outcome === "object" && "error" in outcome) {
            const code = classifyError(outcome.error as PostgrestError | { message?: string });
            const message =
              outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error ?? "unknown");
            next.set(originalIndex, { status: "error", code, message });
          } else {
            const ok = outcome as { memberId: string };
            next.set(originalIndex, { status: "ok", memberId: ok.memberId });
            void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
          }
          return next;
        });
      });

      setIsRunning(false);
    },
    [queryClient],
  );

  const start = useCallback(
    async (rows: ImportRow[]) => {
      if (rows.length === 0) return;
      const allIndices = rows.map((_, i) => i);
      setResults(new Map());
      await runBatch(rows, allIndices);
    },
    [runBatch],
  );

  const retryFailed = useCallback(async () => {
    const rows = lastRowsRef.current;
    if (rows.length === 0) return;
    const failedIndices: number[] = [];
    for (const [i, r] of results.entries()) {
      if (r.status === "error") failedIndices.push(i);
    }
    if (failedIndices.length === 0) return;
    await runBatch(rows, failedIndices);
  }, [results, runBatch]);

  const summary = summarize(results, total);

  return { start, retryFailed, results, summary, isRunning };
}
