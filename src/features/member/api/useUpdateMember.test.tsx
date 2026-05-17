// Story 2.5 / 8.6 — useUpdateMember tests.
//
// Story 8.6 adds the offline branch (queues a member.updated event),
// optimistic cache patch + rollback, and the {wasOffline} return.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const getSessionMock = vi.fn();
const appendEventMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: { getSession: () => getSessionMock() },
  },
}));

import type * as SyncModule from "@/infrastructure/sync";

vi.mock("@/infrastructure/sync", async (importActual) => {
  const actual = await importActual<typeof SyncModule>();
  return { ...actual, appendEvent: (...args: unknown[]) => appendEventMock(...args) };
});

import { OfflineEventLogError } from "@/infrastructure/sync";

import { useUpdateMember, UpdateMemberError } from "./useUpdateMember";
import { MEMBERS_QUERY_KEY, type MemberWithMeta, type UpdateMemberInput } from "../types";

const VALID_ID = "11111111-1111-4111-8111-111111111111";
const COLLECTOR = "22222222-2222-4222-8222-222222222222";

const VALUES: UpdateMemberInput = {
  name: "Awa N.",
  phoneNumber: "+221770000001",
  dailyAmount: 1000,
};

const onlineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

let testClient: QueryClient;
function makeWrapper() {
  testClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={testClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: COLLECTOR } } } });
  appendEventMock.mockReset();
  appendEventMock.mockResolvedValue(undefined);
  setOnline(true);
});

afterEach(() => {
  vi.clearAllMocks();
  if (onlineDescriptor) Object.defineProperty(window.navigator, "onLine", onlineDescriptor);
});

describe("useUpdateMember — online path", () => {
  it("happy path — calls update_member RPC + resolves { wasOffline: false }", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    let res: { wasOffline: boolean } | undefined;
    await act(async () => {
      res = await result.current.mutateAsync({ id: VALID_ID, values: VALUES });
    });

    expect(rpcMock).toHaveBeenCalledWith("update_member", {
      p_id: VALID_ID,
      p_name: "Awa N.",
      p_phone_number: "+221770000001",
      p_daily_amount: 1000,
    });
    expect(res).toEqual({ wasOffline: false });
    expect(appendEventMock).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it.each([
    ["auth_required", { message: "auth_required: caller …" }, "unauthorized"],
    ["23505", { code: "23505", message: "dup" }, "duplicate_phone"],
    ["invalid_amount", { message: "invalid_amount: too big" }, "validation"],
    ["P0002", { code: "P0002", message: "not_found: gone" }, "not_found"],
    ["unrecognised", { message: "boom from outer space" }, "unknown"],
  ])("classifies %s → '%s'", async (_label, error, expectedCode) => {
    rpcMock.mockResolvedValue({ data: null, error });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe(expectedCode));
  });

  it("a 'network'-classified RPC error falls back to the offline queue", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    let res: { wasOffline: boolean } | undefined;
    await act(async () => {
      res = await result.current.mutateAsync({ id: VALID_ID, values: VALUES });
    });
    expect(res).toEqual({ wasOffline: true });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
  });

  it("a TypeError thrown by the RPC falls back to the offline queue", async () => {
    rpcMock.mockRejectedValue(new TypeError("network down"));
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    let res: { wasOffline: boolean } | undefined;
    await act(async () => {
      res = await result.current.mutateAsync({ id: VALID_ID, values: VALUES });
    });
    expect(res).toEqual({ wasOffline: true });
    expect(appendEventMock).toHaveBeenCalledTimes(1);
  });
});

describe("useUpdateMember — offline branch", () => {
  beforeEach(() => setOnline(false));

  it("queues a member.updated event and returns { wasOffline: true }", async () => {
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    let res: { wasOffline: boolean } | undefined;
    await act(async () => {
      res = await result.current.mutateAsync({ id: VALID_ID, values: VALUES });
    });

    expect(res).toEqual({ wasOffline: true });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(appendEventMock).toHaveBeenCalledTimes(1);
    const event = appendEventMock.mock.calls[0]![0] as {
      eventType: string;
      entityId: string;
      payload: Record<string, unknown>;
    };
    expect(event.eventType).toBe("member.updated");
    expect(event.entityId).toBe(VALID_ID);
    expect(event.payload).toMatchObject({
      p_id: VALID_ID,
      p_name: "Awa N.",
      p_phone_number: "+221770000001",
      p_daily_amount: 1000,
    });
  });

  it("no active session → throws UpdateMemberError('unauthorized')", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("unauthorized"));
  });

  it("appendEvent failure → UpdateMemberError('offline_storage')", async () => {
    appendEventMock.mockRejectedValue(new OfflineEventLogError("QUOTA_EXCEEDED", "idb full"));
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });
    await waitFor(() => expect(result.current.error?.code).toBe("offline_storage"));
  });
});

describe("useUpdateMember — optimistic cache", () => {
  function seedMembers(): void {
    const members: MemberWithMeta[] = [
      {
        id: VALID_ID,
        name: "Old Name",
        phoneNumber: "+221770000000",
        dailyAmount: 500,
        displayStatus: "actif",
        currentCycle: null,
        latestInteractionAt: "2026-05-15T00:00:00.000Z",
        cycleAdvancesTotal: 0,
        projectedBalance: null,
      },
    ];
    testClient.setQueryData(MEMBERS_QUERY_KEY, members);
  }

  it("onMutate patches the member-list cache; success keeps it (offline)", async () => {
    setOnline(false);
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });
    seedMembers();

    await act(async () => {
      await result.current.mutateAsync({ id: VALID_ID, values: VALUES });
    });

    const cached = testClient.getQueryData<MemberWithMeta[]>(MEMBERS_QUERY_KEY);
    expect(cached?.[0]).toMatchObject({ name: "Awa N.", dailyAmount: 1000 });
  });

  it("onError rolls the member-list cache back", async () => {
    appendEventMock.mockRejectedValue(new OfflineEventLogError("QUOTA_EXCEEDED", "idb full"));
    setOnline(false);
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });
    seedMembers();

    await act(async () => {
      await expect(
        result.current.mutateAsync({ id: VALID_ID, values: VALUES }),
      ).rejects.toBeInstanceOf(UpdateMemberError);
    });

    const cached = testClient.getQueryData<MemberWithMeta[]>(MEMBERS_QUERY_KEY);
    expect(cached?.[0]).toMatchObject({ name: "Old Name", dailyAmount: 500 });
  });

  it("offline success does NOT invalidate the member queries", async () => {
    setOnline(false);
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });
    seedMembers();
    const invalidateSpy = vi.spyOn(testClient, "invalidateQueries");

    await act(async () => {
      await result.current.mutateAsync({ id: VALID_ID, values: VALUES });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("online success DOES invalidate the member queries", async () => {
    setOnline(true);
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useUpdateMember(), { wrapper: makeWrapper() });
    seedMembers();
    const invalidateSpy = vi.spyOn(testClient, "invalidateQueries");

    await act(async () => {
      await result.current.mutateAsync({ id: VALID_ID, values: VALUES });
    });

    expect(invalidateSpy).toHaveBeenCalled();
  });
});
