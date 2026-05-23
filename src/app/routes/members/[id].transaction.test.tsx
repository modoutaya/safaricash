// Story 4.6 — MemberTransactionRoute tests.
//
// Covers the offline-toast / typed-error dispatch + the closed-cycle
// guard — the behaviour that moved out of MemberList when the
// MemberActionSheet modal was replaced by this route.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as MemberModule from "@/features/member";
import type { MemberWithMeta } from "@/features/member";

const useMembersMock = vi.fn();
const contributionMutateAsyncMock = vi.fn();
const rattrapageMutateAsyncMock = vi.fn();
const showOfflineToastMock = vi.fn();
const showContributionToastMock = vi.fn();
const showRattrapageToastMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/features/member", async () => {
  const actual = await vi.importActual<typeof MemberModule>("@/features/member");
  return { ...actual, useMembers: () => useMembersMock() };
});

vi.mock("@/features/transaction/api/useRecordContribution", () => ({
  useRecordContribution: () => ({ mutateAsync: contributionMutateAsyncMock, isPending: false }),
  RecordContributionError: class RecordContributionError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("@/features/transaction/api/useRecordRattrapage", () => ({
  useRecordRattrapage: () => ({ mutateAsync: rattrapageMutateAsyncMock, isPending: false }),
  RecordRattrapageError: class RecordRattrapageError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("@/features/transaction/api/showOfflineToast", () => ({
  showOfflineToast: (args: unknown) => showOfflineToastMock(args),
}));

vi.mock("@/features/transaction/api/showContributionToast", () => ({
  showContributionToast: (args: unknown) => showContributionToastMock(args),
  showRattrapageToast: (args: unknown) => showRattrapageToastMock(args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}));

import MemberTransactionRoute from "./[id].transaction";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

function memberFixture(overrides: Partial<MemberWithMeta> = {}): MemberWithMeta {
  return {
    id: VALID_ID,
    name: "Awa Diallo",
    phoneNumber: null,
    dailyAmount: 500,
    displayStatus: "actif",
    currentCycle: {
      id: "c1",
      startDate: "2026-04-11",
      endDate: "2026-05-10",
      cycleLength: 30,
      dayNumber: 11,
      openingBalance: 0,
    },
    latestInteractionAt: "2026-04-20T10:00:00Z",
    cycleAdvancesTotal: 0,
    projectedBalance: 14500,
    awaitingSettlement: null,
    lastSettlementAt: null,
    ...overrides,
  };
}

function renderRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/members/${VALID_ID}/transaction`]}>
        <Routes>
          <Route path="/members/:id/transaction" element={<MemberTransactionRoute />} />
          <Route path="/members" element={<div data-testid="members-list" />} />
          <Route path="/members/:id" element={<div data-testid="profile-route" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemberTransactionRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMembersMock.mockReturnValue({ data: [memberFixture()], isLoading: false, isError: false });
  });

  it("fires showOfflineToast (not showContributionToast) when the contribution was offline", async () => {
    contributionMutateAsyncMock.mockResolvedValue({ txId: "tx1", wasOffline: true });
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /confirmer la cotisation/i }));
    await waitFor(() =>
      expect(showOfflineToastMock).toHaveBeenCalledWith({ memberName: "Awa Diallo" }),
    );
    expect(showContributionToastMock).not.toHaveBeenCalled();
  });

  it("fires showContributionToast on an online contribution", async () => {
    contributionMutateAsyncMock.mockResolvedValue({ txId: "tx1", wasOffline: false });
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /confirmer la cotisation/i }));
    await waitFor(() => expect(showContributionToastMock).toHaveBeenCalled());
  });

  it("shows an error toast when the contribution mutation throws a typed error", async () => {
    const { RecordContributionError } =
      await import("@/features/transaction/api/useRecordContribution");
    contributionMutateAsyncMock.mockRejectedValue(
      new RecordContributionError("cycle_closed", "closed"),
    );
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /confirmer la cotisation/i }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
  });

  it("fires showRattrapageToast on an online rattrapage", async () => {
    rattrapageMutateAsyncMock.mockResolvedValue({ txId: "tx2", wasOffline: false });
    renderRoute();
    fireEvent.change(screen.getByLabelText(/type d'opération/i), {
      target: { value: "rattrapage" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^3 jours$/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirmer le rattrapage/i }));
    await waitFor(() => expect(showRattrapageToastMock).toHaveBeenCalled());
  });

  it("redirects to the profile when the member has no active cycle", () => {
    useMembersMock.mockReturnValue({
      data: [memberFixture({ currentCycle: null })],
      isLoading: false,
      isError: false,
    });
    renderRoute();
    expect(screen.getByTestId("profile-route")).toBeInTheDocument();
  });

  it("redirects to /members when the member id is not in the list", () => {
    useMembersMock.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderRoute();
    expect(screen.getByTestId("members-list")).toBeInTheDocument();
  });
});
