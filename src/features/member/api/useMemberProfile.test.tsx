// Story 2.4 — useMemberProfile + fetchProfile tests.
//
// Tests the pure async fetchProfile() function directly (avoids over-
// complicated mocking of the 3-parallel supabase query chain). The hook
// itself is a thin TanStack useQuery wrapper around fetchProfile + a
// disabled-when-undefined guard — the latter is asserted via the hook
// in a single guard test.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memberMaybeSingle = vi.fn();
const cyclesEq = vi.fn();
const transactionsEq = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: (() => {
          if (table === "members_decrypted") {
            return () => ({ maybeSingle: memberMaybeSingle });
          }
          if (table === "cycles") {
            return cyclesEq;
          }
          return transactionsEq;
        })(),
      }),
    }),
  },
}));

import { fetchProfile, useMemberProfile } from "./useMemberProfile";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

const MEMBER_ROW = {
  id: VALID_ID,
  collector_id: "00000000-0000-4000-8000-000000000001",
  name: "Awa Diallo",
  phone_number: "+221777915898",
  daily_amount: 500,
  status: "active" as const,
  created_at: "2026-04-12T08:00:00Z",
  updated_at: "2026-04-12T08:00:00Z",
  // Story 6.7 — column added to the members_decrypted SELECT.
  sms_opt_out: false,
};

const CYCLE = {
  id: "22222222-2222-4222-8222-222222222222",
  member_id: VALID_ID,
  cycle_number: 1,
  start_date: "2026-04-12",
  end_date: "2026-05-11",
  status: "active" as const,
};

describe("fetchProfile", () => {
  beforeEach(() => {
    memberMaybeSingle.mockReset();
    cyclesEq.mockReset();
    transactionsEq.mockReset();
  });

  it("happy path — joins all 3 queries and computes stats", async () => {
    memberMaybeSingle.mockResolvedValue({ data: MEMBER_ROW, error: null });
    cyclesEq.mockResolvedValue({ data: [CYCLE], error: null });
    transactionsEq.mockResolvedValue({
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          member_id: VALID_ID,
          cycle_id: "22222222-2222-4222-8222-222222222222",
          kind: "contribution",
          amount: 500,
          cycle_day: 1,
          created_at: "2026-04-12T09:00:00Z",
          // Story 6.7 (AC #17) — receipt_token is now part of the
          // transactions_decrypted projection.
          receipt_token: "a".repeat(32),
        },
      ],
      error: null,
    });

    const result = await fetchProfile(VALID_ID);
    expect(result?.member.name).toBe("Awa Diallo");
    expect(result?.currentCycle?.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(result?.transactions).toHaveLength(1);
    // Story 6.7 AC #17 — receipt_token round-trips through the view +
    // Zod parse + member-profile assembly so the share button can read it.
    expect(result?.transactions[0]?.receipt_token).toBe("a".repeat(32));
    // Story 6.7 — sms_opt_out is exposed on the member shape.
    expect(result?.member.sms_opt_out).toBe(false);
    expect(result?.stats.contributedTotal).toBe(500);
    expect(result?.stats.projectedFinalBalance).toBe(500 * 29);
  });

  it("member-not-found — returns undefined", async () => {
    memberMaybeSingle.mockResolvedValue({ data: null, error: null });
    cyclesEq.mockResolvedValue({ data: [], error: null });
    transactionsEq.mockResolvedValue({ data: [], error: null });

    const result = await fetchProfile(VALID_ID);
    expect(result).toBeUndefined();
  });

  it("member query fails — throws", async () => {
    memberMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    cyclesEq.mockResolvedValue({ data: [], error: null });
    transactionsEq.mockResolvedValue({ data: [], error: null });

    await expect(fetchProfile(VALID_ID)).rejects.toThrow(/member profile query failed/);
  });

  it("filters transactions to the current cycle id only", async () => {
    memberMaybeSingle.mockResolvedValue({ data: MEMBER_ROW, error: null });
    cyclesEq.mockResolvedValue({ data: [CYCLE], error: null });
    transactionsEq.mockResolvedValue({
      data: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          member_id: VALID_ID,
          cycle_id: "22222222-2222-4222-8222-222222222222", // current
          kind: "contribution",
          amount: 500,
          cycle_day: 1,
          created_at: "2026-04-12T09:00:00Z",
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          member_id: VALID_ID,
          cycle_id: "66666666-6666-4666-8666-666666666666", // previous cycle
          kind: "contribution",
          amount: 999,
          cycle_day: 5,
          created_at: "2026-03-12T09:00:00Z",
        },
      ],
      error: null,
    });

    const result = await fetchProfile(VALID_ID);
    expect(result?.transactions).toHaveLength(1);
    expect(result?.transactions[0]?.id).toBe("44444444-4444-4444-8444-444444444444");
    // Story 2.6 — totalTransactionsCount counts ALL cycles (here: 2).
    expect(result?.totalTransactionsCount).toBe(2);
  });

  it("Story 2.7 — exposes previousCycles (completed/settled, newest first, excluding current)", async () => {
    memberMaybeSingle.mockResolvedValue({ data: MEMBER_ROW, error: null });
    cyclesEq.mockResolvedValue({
      data: [
        { ...CYCLE, cycle_number: 3 },
        {
          id: "77777777-7777-4777-8777-777777777777",
          member_id: VALID_ID,
          cycle_number: 2,
          start_date: "2026-03-12",
          end_date: "2026-04-10",
          status: "completed",
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          member_id: VALID_ID,
          cycle_number: 1,
          start_date: "2026-02-12",
          end_date: "2026-03-13",
          status: "settled",
        },
      ],
      error: null,
    });
    transactionsEq.mockResolvedValue({ data: [], error: null });

    const result = await fetchProfile(VALID_ID);
    expect(result?.currentCycle?.cycle_number).toBe(3);
    expect(result?.previousCycles).toHaveLength(2);
    expect(result?.previousCycles[0]?.cycle_number).toBe(2);
    expect(result?.previousCycles[1]?.cycle_number).toBe(1);
  });

  it("Story 2.7 — currentCycle falls back to a completed cycle when no active exists", async () => {
    memberMaybeSingle.mockResolvedValue({ data: MEMBER_ROW, error: null });
    cyclesEq.mockResolvedValue({
      data: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          member_id: VALID_ID,
          cycle_number: 2,
          start_date: "2026-03-12",
          end_date: "2026-04-10",
          status: "completed",
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          member_id: VALID_ID,
          cycle_number: 1,
          start_date: "2026-02-12",
          end_date: "2026-03-13",
          status: "completed",
        },
      ],
      error: null,
    });
    transactionsEq.mockResolvedValue({ data: [], error: null });

    const result = await fetchProfile(VALID_ID);
    // Highest-numbered completed cycle is "promoted" to current.
    expect(result?.currentCycle?.cycle_number).toBe(2);
    expect(result?.currentCycle?.status).toBe("completed");
    // The lower-numbered completed cycle is in previousCycles.
    expect(result?.previousCycles).toHaveLength(1);
    expect(result?.previousCycles[0]?.cycle_number).toBe(1);
  });
});

describe("useMemberProfile (hook guard)", () => {
  it("disabled when id is undefined — never fires the query", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function QueryWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    memberMaybeSingle.mockReset();
    cyclesEq.mockReset();
    transactionsEq.mockReset();

    const { result } = renderHook(() => useMemberProfile(undefined), { wrapper: QueryWrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(memberMaybeSingle).not.toHaveBeenCalled();
  });
});
