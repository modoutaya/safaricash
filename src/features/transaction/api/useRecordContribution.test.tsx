// Story 4.3 — useRecordContribution tests covering each error code.
// Story 8.3 — offline-fallback + optimistic UI tests.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: {
      getSession: () => getSessionMock(),
    },
  },
}));

const appendEventMock = vi.fn();
vi.mock("@/infrastructure/sync", () => ({
  appendEvent: (event: unknown) => appendEventMock(event),
}));

import { MEMBERS_QUERY_KEY, type MemberWithMeta } from "@/features/member";

import { useRecordContribution, RecordContributionError } from "./useRecordContribution";

const INPUT = {
  memberId: "11111111-1111-4111-8111-111111111111",
  cycleId: "22222222-2222-4222-8222-222222222222",
  amount: 500,
  cycleDay: 5,
};

function makeWrapper(): {
  wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

const COLLECTOR_ID = "44444444-4444-4444-8444-444444444444";

describe("useRecordContribution", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    appendEventMock.mockReset();
    appendEventMock.mockResolvedValue(undefined);
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: COLLECTOR_ID } } } });
    // Default to online so existing error-classification tests behave unchanged.
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — calls record_contribution RPC + returns the new tx id", async () => {
    rpcMock.mockResolvedValue({ data: "33333333-3333-4333-8333-333333333333", error: null });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });

    let returned: { txId: string; wasOffline: boolean } | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(INPUT);
    });

    expect(rpcMock).toHaveBeenCalledWith("record_contribution", {
      p_member_id: INPUT.memberId,
      p_cycle_id: INPUT.cycleId,
      p_amount: INPUT.amount,
      p_cycle_day: INPUT.cycleDay,
    });
    expect(returned).toEqual({
      txId: "33333333-3333-4333-8333-333333333333",
      wasOffline: false,
    });
    expect(appendEventMock).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("classifies sqlstate 23514 as 'cycle_closed' (Story 3.4 trigger)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "23514", message: "cycle_closed: …" } });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("cycle_closed"));
  });

  it("classifies auth_required as 'unauthorized'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "auth_required: …" } });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unauthorized"));
  });

  it("classifies invalid_amount as 'validation'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "invalid_amount: …" } });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("validation"));
  });

  it("classifies P0002 as 'not_found'", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found: …" } });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("not_found"));
  });

  it("falls back to 'unknown' for unrecognised errors", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom from outer space" } });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unknown"));
  });

  // -------------------------------------------------------------------------
  // Story 8.3 — offline-fallback branch
  // -------------------------------------------------------------------------

  it("navigator.onLine === false → skips RPC, appends to event log, returns wasOffline=true", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });

    let returned: { txId: string; wasOffline: boolean } | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(INPUT);
    });

    expect(rpcMock).not.toHaveBeenCalled();
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    const event = appendEventMock.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      eventType: "transaction.contribution_recorded",
      collectorId: COLLECTOR_ID,
      actor: COLLECTOR_ID,
      source: "offline_reconciled",
    });
    expect(returned?.wasOffline).toBe(true);
    expect(returned?.txId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("online but RPC rejects with TypeError → falls back to offline branch", async () => {
    rpcMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });

    let returned: { txId: string; wasOffline: boolean } | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(INPUT);
    });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    expect(returned?.wasOffline).toBe(true);
  });

  it("non-network RPC error propagates without appending to the event log", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "23514", message: "cycle_closed: …" },
    });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toMatchObject({
        code: "cycle_closed",
      });
    });

    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it("offline mutation throws 'unauthorized' when session is null", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const { result } = renderHook(() => useRecordContribution(), {
      wrapper: makeWrapper().wrapper,
    });

    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toMatchObject({
        code: "unauthorized",
      });
    });

    expect(appendEventMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Story 8.3 — optimistic UI
  // -------------------------------------------------------------------------

  it("onMutate bumps the member to the top of the MEMBERS_QUERY_KEY cache", async () => {
    const fixtures: MemberWithMeta[] = [
      {
        id: "aaaa1111-1111-4111-8111-111111111111",
        name: "Aïssatou",
        phoneNumber: null,
        dailyAmount: 500,
        displayStatus: "actif",
        currentCycle: null,
        latestInteractionAt: "2026-04-01T10:00:00.000Z",
        cycleAdvancesTotal: 0,
        projectedBalance: null,
        awaitingSettlement: null,
      },
      {
        id: INPUT.memberId,
        name: "Member-Target",
        phoneNumber: null,
        dailyAmount: 500,
        displayStatus: "actif",
        currentCycle: null,
        latestInteractionAt: "2026-04-01T08:00:00.000Z",
        cycleAdvancesTotal: 0,
        projectedBalance: null,
        awaitingSettlement: null,
      },
    ];
    const { client, wrapper } = makeWrapper();
    client.setQueryData<MemberWithMeta[]>([...MEMBERS_QUERY_KEY], fixtures);
    rpcMock.mockResolvedValue({ data: "33333333-3333-4333-8333-333333333333", error: null });

    const { result } = renderHook(() => useRecordContribution(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(INPUT);
    });

    const updated = client.getQueryData<MemberWithMeta[]>([...MEMBERS_QUERY_KEY]);
    expect(updated?.[0]?.id).toBe(INPUT.memberId);
    expect(updated?.[1]?.id).toBe("aaaa1111-1111-4111-8111-111111111111");
    // Story 8.3 patch — also verify latestInteractionAt was actually
    // bumped (the sort could pass by coincidence without this check).
    expect(updated?.[0]?.latestInteractionAt).not.toBe("2026-04-01T08:00:00.000Z");
    expect(updated?.[0]?.latestInteractionAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("onError rollback restores the previous MEMBERS_QUERY_KEY snapshot", async () => {
    const original: MemberWithMeta[] = [
      {
        id: "aaaa1111-1111-4111-8111-111111111111",
        name: "First",
        phoneNumber: null,
        dailyAmount: 500,
        displayStatus: "actif",
        currentCycle: null,
        latestInteractionAt: "2026-04-01T10:00:00.000Z",
        cycleAdvancesTotal: 0,
        projectedBalance: null,
        awaitingSettlement: null,
      },
      {
        id: INPUT.memberId,
        name: "Target",
        phoneNumber: null,
        dailyAmount: 500,
        displayStatus: "actif",
        currentCycle: null,
        latestInteractionAt: "2026-04-01T08:00:00.000Z",
        cycleAdvancesTotal: 0,
        projectedBalance: null,
        awaitingSettlement: null,
      },
    ];
    const { client, wrapper } = makeWrapper();
    client.setQueryData<MemberWithMeta[]>([...MEMBERS_QUERY_KEY], original);
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "23514", message: "cycle_closed: …" },
    });

    const { result } = renderHook(() => useRecordContribution(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(INPUT)).rejects.toBeInstanceOf(
        RecordContributionError,
      );
    });

    const restored = client.getQueryData<MemberWithMeta[]>([...MEMBERS_QUERY_KEY]);
    expect(restored?.[0]?.id).toBe("aaaa1111-1111-4111-8111-111111111111");
    expect(restored?.[1]?.id).toBe(INPUT.memberId);
  });
});
