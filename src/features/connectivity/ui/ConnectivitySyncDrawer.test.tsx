// Story 8.1 / 8.5 — ConnectivitySyncDrawer tests.
//
// Story 8.5 fills the skeleton body: pending-operations list (by member),
// the stalled banner (sync-failed only), and the manual "Retenter" CTA.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MEMBERS_QUERY_KEY } from "@/features/member";
import type { OfflineEvent, OfflineEventType, ReplayResult } from "@/infrastructure/sync";

import type { ConnectivityStateValue } from "../api/useConnectivityState";
import { ConnectivitySyncDrawer } from "./ConnectivitySyncDrawer";

expect.extend(toHaveNoViolations);

const listEventsMock = vi.fn();
const replayPendingEventsMock = vi.fn();
const useCollectorIdMock = vi.fn();

vi.mock("@/infrastructure/sync", () => ({
  listEvents: (id: string) => listEventsMock(id),
  replayPendingEvents: (id: string) => replayPendingEventsMock(id),
}));

vi.mock("@/features/auth/api/useCollectorId", () => ({
  useCollectorId: () => useCollectorIdMock(),
}));

const COLLECTOR = "11111111-1111-4111-8111-111111111111";
const MEMBER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeEvent(
  eventType: OfflineEventType,
  memberId: string,
  overrides: Partial<OfflineEvent> = {},
): OfflineEvent {
  const eventId = overrides.eventId ?? crypto.randomUUID();
  return {
    eventId,
    eventType,
    collectorId: COLLECTOR,
    entityId: crypto.randomUUID(),
    timestamp: "2026-05-15T09:30:00.000000Z",
    actor: COLLECTOR,
    source: "offline_reconciled",
    payload: { p_member_id: memberId },
    ...overrides,
  };
}

function makeResult(overrides: Partial<ReplayResult> = {}): ReplayResult {
  return {
    attempted: 1,
    succeeded: 1,
    skipped: 0,
    networkFailures: 0,
    sessionFailures: 0,
    durationMs: 12,
    ...overrides,
  };
}

function renderDrawer(
  props: Partial<{
    open: boolean;
    pendingCount: number;
    state: ConnectivityStateValue;
    onOpenChange: (n: boolean) => void;
  }> = {},
): { ui: ReactElement; queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(MEMBERS_QUERY_KEY, [
    { id: MEMBER_A, name: "Awa Diop" },
    { id: MEMBER_B, name: "Bintou Fall" },
  ]);
  const ui = (
    <QueryClientProvider client={queryClient}>
      <ConnectivitySyncDrawer
        open={props.open ?? true}
        onOpenChange={props.onOpenChange ?? vi.fn()}
        pendingCount={props.pendingCount ?? 0}
        state={props.state ?? "connected"}
      />
    </QueryClientProvider>
  );
  return { ui, queryClient };
}

beforeEach(() => {
  // jsdom doesn't ship <dialog>'s show/close — same shim as Stories 6.6 / 7.4.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  listEventsMock.mockReset();
  listEventsMock.mockResolvedValue([]);
  replayPendingEventsMock.mockReset();
  replayPendingEventsMock.mockResolvedValue(makeResult());
  useCollectorIdMock.mockReset();
  useCollectorIdMock.mockReturnValue(COLLECTOR);
});

describe("ConnectivitySyncDrawer", () => {
  it("open=true renders the title + close button", () => {
    const { ui } = renderDrawer({ pendingCount: 0 });
    render(ui);
    expect(screen.getByRole("heading", { level: 2, name: /Synchronisation/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Fermer/ })).toHaveLength(2);
  });

  it("pendingCount === 0 → empty-state message, no list, no retry CTA", () => {
    const { ui } = renderDrawer({ pendingCount: 0 });
    render(ui);
    expect(screen.getByText("Aucune opération en attente.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retenter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("pendingCount > 0 + syncing → list + retry CTA, NO stalled banner", async () => {
    listEventsMock.mockResolvedValue([makeEvent("transaction.contribution_recorded", MEMBER_A)]);
    const { ui } = renderDrawer({ pendingCount: 1, state: "syncing" });
    render(ui);
    expect(await screen.findByText(/Cotisation — Awa Diop/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retenter/ })).toBeInTheDocument();
    expect(screen.queryByText(/La synchronisation est bloquée/)).not.toBeInTheDocument();
  });

  it("pendingCount > 0 + sync-failed → stalled banner + list + retry CTA", async () => {
    listEventsMock.mockResolvedValue([makeEvent("transaction.advance_recorded", MEMBER_B)]);
    const { ui } = renderDrawer({ pendingCount: 1, state: "sync-failed" });
    render(ui);
    expect(await screen.findByText(/La synchronisation est bloquée/)).toBeInTheDocument();
    expect(screen.getByText(/Avance — Bintou Fall/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retenter/ })).toBeInTheDocument();
  });

  it("member name falls back to a neutral label when not in cache", async () => {
    listEventsMock.mockResolvedValue([
      makeEvent("transaction.rattrapage_recorded", "unknown-member-id"),
    ]);
    const { ui } = renderDrawer({ pendingCount: 1, state: "syncing" });
    render(ui);
    expect(await screen.findByText(/Rattrapage — Membre/)).toBeInTheDocument();
  });

  it("'Retenter' calls replayPendingEvents with the collector id", async () => {
    listEventsMock.mockResolvedValue([makeEvent("transaction.contribution_recorded", MEMBER_A)]);
    const { ui } = renderDrawer({ pendingCount: 1, state: "sync-failed" });
    render(ui);
    const retry = await screen.findByRole("button", { name: /Retenter/ });
    fireEvent.click(retry);
    await waitFor(() => expect(replayPendingEventsMock).toHaveBeenCalledWith(COLLECTOR));
  });

  it("'Retenter' is disabled while a drain is in flight", async () => {
    listEventsMock.mockResolvedValue([makeEvent("transaction.contribution_recorded", MEMBER_A)]);
    let resolveDrain: (r: ReplayResult) => void = () => {};
    replayPendingEventsMock.mockReturnValue(
      new Promise<ReplayResult>((resolve) => {
        resolveDrain = resolve;
      }),
    );
    const { ui } = renderDrawer({ pendingCount: 1, state: "sync-failed" });
    render(ui);
    const retry = await screen.findByRole("button", { name: /Retenter/ });
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toBeDisabled());
    resolveDrain(makeResult());
    await waitFor(() => expect(retry).not.toBeDisabled());
  });

  it("session-expired result → shows the re-auth hint", async () => {
    listEventsMock.mockResolvedValue([makeEvent("transaction.contribution_recorded", MEMBER_A)]);
    replayPendingEventsMock.mockResolvedValue(
      makeResult({ succeeded: 0, sessionFailures: 1, attempted: 1 }),
    );
    const { ui } = renderDrawer({ pendingCount: 1, state: "sync-failed" });
    render(ui);
    fireEvent.click(await screen.findByRole("button", { name: /Retenter/ }));
    expect(await screen.findByText(/Votre session a expiré/)).toBeInTheDocument();
  });

  it("retry that drains the queue → drawer transitions to the empty state", async () => {
    // First load returns one event; the post-retry refresh returns [].
    listEventsMock.mockResolvedValueOnce([
      makeEvent("transaction.contribution_recorded", MEMBER_A),
    ]);
    listEventsMock.mockResolvedValue([]);
    replayPendingEventsMock.mockResolvedValue(makeResult({ succeeded: 1 }));
    const { ui } = renderDrawer({ pendingCount: 1, state: "sync-failed" });
    render(ui);
    fireEvent.click(await screen.findByRole("button", { name: /Retenter/ }));
    // Even though the pendingCount prop is still 1 (parent not yet updated),
    // the drained list flips the drawer to the empty state.
    expect(await screen.findByText("Aucune opération en attente.")).toBeInTheDocument();
  });

  it("close button (X icon) fires onOpenChange(false) exactly once", () => {
    const onOpenChange = vi.fn();
    const { ui } = renderDrawer({ pendingCount: 0, onOpenChange });
    render(ui);
    fireEvent.click(screen.getAllByRole("button", { name: /Fermer/ })[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("outline 'Fermer' button also fires onOpenChange(false) exactly once", () => {
    const onOpenChange = vi.fn();
    const { ui } = renderDrawer({ pendingCount: 0, onOpenChange });
    render(ui);
    // [0] is the X icon button, [1] is the outline Button.
    fireEvent.click(screen.getAllByRole("button", { name: /Fermer/ })[1]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("focus lands on the X close button after mount", async () => {
    const { ui } = renderDrawer({ pendingCount: 0 });
    render(ui);
    const xButton = screen.getAllByRole("button", { name: /Fermer/ })[0]!;
    await waitFor(() => expect(document.activeElement).toBe(xButton));
  });

  it("axe-clean in syncing + sync-failed states", async () => {
    listEventsMock.mockResolvedValue([makeEvent("transaction.contribution_recorded", MEMBER_A)]);
    for (const state of ["syncing", "sync-failed"] as ConnectivityStateValue[]) {
      const { ui } = renderDrawer({ pendingCount: 1, state });
      const { container, unmount } = render(ui);
      await screen.findByText(/Cotisation — Awa Diop/);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
