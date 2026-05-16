// Story 10.3 — useDisputeRealtime tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channelMock = vi.fn();
const removeChannelMock = vi.fn();
const collectorIdMock = vi.fn();
const toastMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    channel: (...args: unknown[]) => channelMock(...args),
    removeChannel: (...args: unknown[]) => removeChannelMock(...args),
  },
}));
vi.mock("@/features/auth/api/useCollectorId", () => ({
  useCollectorId: () => collectorIdMock(),
}));
vi.mock("sonner", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

import { useDisputeRealtime } from "./useDisputeRealtime";
import { DISPUTES_QUERY_KEY } from "../types";

const COLLECTOR_ID = "c0000000-0000-4000-8000-000000000001";
const MEMBER_ID = "m0000000-0000-4000-8000-000000000002";

let broadcastCallback: ((msg: { payload: unknown }) => void) | null = null;
let subscribeCallback: ((status: string) => void) | null = null;

/** Channel stub: `.on` records the broadcast callback, `.subscribe`
 *  records the status callback + returns the channel — both chainable
 *  like the real RealtimeChannel. */
function setupChannel() {
  broadcastCallback = null;
  subscribeCallback = null;
  const ch: Record<string, unknown> = {};
  ch.on = (_type: string, _filter: unknown, cb: (msg: { payload: unknown }) => void) => {
    broadcastCallback = cb;
    return ch;
  };
  ch.subscribe = (cb: (status: string) => void) => {
    subscribeCallback = cb;
    return ch;
  };
  channelMock.mockReturnValue(ch);
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useDisputeRealtime", () => {
  beforeEach(() => {
    channelMock.mockReset();
    removeChannelMock.mockReset();
    collectorIdMock.mockReset();
    toastMock.mockReset();
    setupChannel();
  });
  afterEach(() => vi.clearAllMocks());

  it("subscribes to the collector dispute channel when a collector id is present", () => {
    collectorIdMock.mockReturnValue(COLLECTOR_ID);
    renderHook(() => useDisputeRealtime(), { wrapper: wrapperFor(makeClient()) });
    expect(channelMock).toHaveBeenCalledWith(`disputes:${COLLECTOR_ID}`);
  });

  it("does not subscribe when there is no collector id", () => {
    collectorIdMock.mockReturnValue(null);
    renderHook(() => useDisputeRealtime(), { wrapper: wrapperFor(makeClient()) });
    expect(channelMock).not.toHaveBeenCalled();
  });

  it("on a dispute_flagged broadcast → toasts + invalidates the member's disputes query", () => {
    collectorIdMock.mockReturnValue(COLLECTOR_ID);
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useDisputeRealtime(), { wrapper: wrapperFor(client) });

    expect(broadcastCallback).not.toBeNull();
    broadcastCallback!({ payload: { member_id: MEMBER_ID } });

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: [...DISPUTES_QUERY_KEY, "member", MEMBER_ID],
    });
  });

  it("logs a warning only on a failed subscribe status", () => {
    collectorIdMock.mockReturnValue(COLLECTOR_ID);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useDisputeRealtime(), { wrapper: wrapperFor(makeClient()) });

    expect(subscribeCallback).not.toBeNull();
    subscribeCallback!("SUBSCRIBED");
    expect(warnSpy).not.toHaveBeenCalled();
    subscribeCallback!("CHANNEL_ERROR");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/dispute-realtime/);

    warnSpy.mockRestore();
  });

  it("removes the channel on unmount", () => {
    collectorIdMock.mockReturnValue(COLLECTOR_ID);
    const { unmount } = renderHook(() => useDisputeRealtime(), {
      wrapper: wrapperFor(makeClient()),
    });
    unmount();
    expect(removeChannelMock).toHaveBeenCalledTimes(1);
  });
});
