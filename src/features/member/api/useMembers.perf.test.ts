// Story 2.1 — NFR-P2 performance sanity gate.
//
// Synthesises 150 members + embedded cycles + transactions, then benchmarks
// the pure derivation + filter pipeline over N iterations. Asserts the p95
// of a single run is under 16 ms (one frame at 60 Hz) — well below the
// NFR-P2 end-to-end budget of 300 ms, which includes PostgREST round-trip.
// If this regresses, someone has O(n²)-introduced derivation or filter.

import { describe, expect, it } from "vitest";

import type { MembersListRow } from "../types";
import { normalizeForSearch } from "./normalizeForSearch";
import { deriveMembersWithMeta } from "./useMembers";

const ITERATIONS = 200;
const P95_BUDGET_MS = 16;

const STATUSES = ["active", "active", "active", "completed", "paused"] as const;
const CYCLE_STATUSES = ["active", "active", "active", "with_advance", "completed"] as const;

function synthesiseRows(n: number): MembersListRow[] {
  const rows: MembersListRow[] = [];
  for (let i = 0; i < n; i++) {
    const status = STATUSES[i % STATUSES.length]!;
    const cycleStatus = CYCLE_STATUSES[i % CYCLE_STATUSES.length]!;
    rows.push({
      id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      collector_id: "22222222-2222-4222-8222-222222222222",
      name: `Fâtou Ndiâye ${i}`,
      phone_number: `+221770000${String(i).padStart(3, "0")}`,
      daily_amount: 500,
      status,
      created_at: new Date(2026, 3, 1 + (i % 20)).toISOString(),
      updated_at: new Date(2026, 3, 1 + (i % 20)).toISOString(),
      cycles: [
        {
          id: `c-${i}`,
          cycle_number: 1,
          start_date: "2026-04-11",
          end_date: "2026-05-10",
          status: cycleStatus,
        },
      ],
      transactions: Array.from({ length: (i % 7) + 1 }, (_, k) => ({
        created_at: new Date(2026, 3, 10 + k).toISOString(),
      })),
    });
  }
  return rows;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

describe("useMembers derivation + filter perf (NFR-P2)", () => {
  it(`stays under ${P95_BUDGET_MS}ms p95 for 150 members × derive + search filter`, () => {
    const rows = synthesiseRows(150);
    const now = new Date("2026-04-21T12:00:00Z");
    const needle = normalizeForSearch("fatou");

    const timings: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const derived = deriveMembersWithMeta(rows, now);
      // Simulate the MemberList filter pass.
      const filtered = derived.filter((m) => normalizeForSearch(m.name).includes(needle));
      // Prevent dead-code elimination of the filter result.
      if (filtered.length === 0) throw new Error("unexpected empty filter");
      timings.push(performance.now() - start);
    }

    const p95 = percentile(timings, 95);
    expect(p95, `p95 ${p95.toFixed(2)}ms exceeds budget ${P95_BUDGET_MS}ms`).toBeLessThan(
      P95_BUDGET_MS,
    );
  });
});
