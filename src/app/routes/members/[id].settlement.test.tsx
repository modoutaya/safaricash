// Story 7.3 — /members/:id/settlement route smoke + precondition guards.
// Story 7.4 — extended for dialog flow + post-commit view-swap + error toasts.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as MemberModule from "@/features/member";

const useMemberProfileMock = vi.fn();
const mutateAsyncMock = vi.fn();
const useCommitSettlementMock = vi.fn();

vi.mock("@/features/member", async () => {
  const actual = await vi.importActual<typeof MemberModule>("@/features/member");
  return {
    ...actual,
    useMemberProfile: (id: string | undefined) => useMemberProfileMock(id),
  };
});

// Story 7.4 — mock the settlement hook + error class. The dialog
// imports useCommitSettlement directly; this mock covers both the route
// (which reads isPending) and the dialog (which calls mutateAsync).
vi.mock("@/features/settlement/api/useCommitSettlement", () => ({
  useCommitSettlement: () => useCommitSettlementMock(),
}));

vi.mock("@/features/settlement/api/commitSettlementError", () => {
  class CommitSettlementError extends Error {
    public readonly code: string;
    public readonly serverPayout: number | undefined;
    constructor(code: string, message: string, serverPayout?: number) {
      super(message);
      this.code = code;
      this.serverPayout = serverPayout;
      this.name = "CommitSettlementError";
    }
  }
  return { CommitSettlementError };
});

const toastInfoMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

import MemberSettlementRoute from "./[id].settlement";

const VALID_ID = "11111111-1111-4111-8111-111111111111";
const CYCLE_ID = "22222222-2222-4222-8222-222222222222";

const MEMBER = {
  id: VALID_ID,
  collector_id: "00000000-0000-4000-8000-000000000001",
  name: "Awa Diallo",
  phone_number: "+221777915898",
  daily_amount: 500,
  status: "active" as const,
  created_at: "2026-04-12T08:00:00Z",
  updated_at: "2026-04-12T08:00:00Z",
  sms_opt_out: false,
};

type CycleStatus = "active" | "with_advance" | "completed" | "settled";

const COMPLETED_CYCLE: {
  id: string;
  cycle_number: number;
  start_date: string;
  end_date: string;
  status: CycleStatus;
} = {
  id: CYCLE_ID,
  cycle_number: 3,
  start_date: "2026-04-12",
  end_date: "2026-05-11",
  status: "completed",
};

function makeTx(
  kind: "contribution" | "advance" | "rattrapage",
  amount: number,
  createdAt: string,
) {
  return {
    id: `tx-${createdAt}-${kind}`,
    member_id: VALID_ID,
    cycle_id: CYCLE_ID,
    kind,
    amount,
    cycle_day: 15,
    created_at: createdAt,
  };
}

function baseData(overrides: Partial<ReturnType<typeof buildBase>> = {}) {
  return { ...buildBase(), ...overrides };
}
function buildBase() {
  // Story 12.5 — settle() now uses actual contributedTotal. Fixture
  // mixes 29 days × 500 cotised + 1 advance of 3 000 so the payout
  // matches the legacy 11 500 number with the new formula:
  // 14 500 − 500(commission) − 3 000(advance) = 11 000. Updated.
  const contributionTxs = Array.from({ length: 29 }, (_, i) =>
    makeTx(
      "contribution",
      500,
      new Date(2026, 3, 13 + i, 9, 0, 0).toISOString().replace(".000Z", "Z"),
    ),
  );
  const txs = [...contributionTxs, makeTx("advance", 3_000, "2026-04-20T11:00:00Z")];
  return {
    member: MEMBER,
    currentCycle: COMPLETED_CYCLE as typeof COMPLETED_CYCLE | null,
    previousCycles: [] as (typeof COMPLETED_CYCLE)[],
    // Story 12.4 — settlement route now targets cycleAwaitingSettlement.
    // Pre-Phase-B model: the cycle to settle equals currentCycle.
    cycleAwaitingSettlement: COMPLETED_CYCLE as typeof COMPLETED_CYCLE | null,
    transactions: txs,
    allTransactions: txs,
    stats: {
      cycleDay: 30,
      cycleLength: 30,
      daysRemaining: 0,
      contributedTotal: 14_500,
      outstandingAdvances: 3_000,
      openingBalance: 0,
      // Story 12.5 — payout = contributedTotal − daily − advances
      //   = 14 500 − 500 − 3 000 = 11 000.
      currentBalance: 14_500 - 500 - 3_000,
    },
    totalTransactionsCount: 30,
  };
}

function renderRoute(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/members/:id/settlement" element={<MemberSettlementRoute />} />
          <Route path="/members/:id" element={<div data-testid="profile-sentinel">profile</div>} />
          <Route path="/members" element={<div data-testid="members-sentinel">members-list</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemberSettlementRoute", () => {
  beforeEach(() => {
    useMemberProfileMock.mockReset();
    toastInfoMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    mutateAsyncMock.mockReset();
    // Default mock — tests can override useCommitSettlementMock.mockReturnValue per case.
    useCommitSettlementMock.mockReturnValue({
      isPending: false,
      error: null,
      mutateAsync: mutateAsyncMock,
    });
    // jsdom doesn't ship <dialog> open/close — same shim as Stories 2.6 / 6.6 tests.
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  it("happy path — completed cycle renders the card with member + cycle range + payout", () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    // Page-level h1 from the route
    expect(
      screen.getByRole("heading", { level: 1, name: /Paiement du membre/ }),
    ).toBeInTheDocument();
    // Card's h2 = member name
    expect(screen.getByRole("heading", { level: 2, name: /Awa Diallo/ })).toBeInTheDocument();
    // Cycle date range
    expect(screen.getByText(/Cycle du 12\/04\/2026 au 11\/05\/2026/)).toBeInTheDocument();
    // Fixture cycle (2026-04-12 \u2192 2026-05-11) is 30 days \u2192 contributionDays 29.
    // Final payout = settle(500, [3000], 29) = 500 \u00d7 29 \u2212 3000 = 11 500 FCFA.
    // Story 12.5 \u2014 payout = contributedTotal(14 500) \u2212 daily(500) \u2212 advance(3 000) = 11 000.
    expect(screen.getByText(/11[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    // Both CTAs present
    expect(screen.getByRole("button", { name: /Vérifier les transactions/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirmer le paiement/ })).toBeInTheDocument();
    // Back chevron present
    expect(screen.getByRole("button", { name: /Retour au profil/ })).toBeInTheDocument();
  });

  // Story 12.4 — guard was rewritten: redirect when
  // `cycleAwaitingSettlement == null`, i.e. no cycle in 'completed' status
  // exists across the member's history. The fixtures below clear both
  // currentCycle's settle-relevant status AND cycleAwaitingSettlement.

  it("precondition guard — no awaiting-settlement cycle ('active' current) → redirects to profile", () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData({
        currentCycle: { ...COMPLETED_CYCLE, status: "active" },
        cycleAwaitingSettlement: null,
      }),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument();
    // No settlement UI
    expect(
      screen.queryByRole("heading", { level: 1, name: /Paiement du membre/ }),
    ).not.toBeInTheDocument();
  });

  it("precondition guard — no awaiting-settlement cycle ('settled' current) → redirects to profile", () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData({
        currentCycle: { ...COMPLETED_CYCLE, status: "settled" },
        cycleAwaitingSettlement: null,
      }),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument();
  });

  it("precondition guard — no awaiting-settlement cycle ('with_advance' current) → redirects to profile", () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData({
        currentCycle: { ...COMPLETED_CYCLE, status: "with_advance" },
        cycleAwaitingSettlement: null,
      }),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument();
  });

  it("precondition guard — no cycle at all → redirects to profile", () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData({ currentCycle: null, cycleAwaitingSettlement: null }),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument();
  });

  it("UUID guard — malformed id → redirects to /members", () => {
    useMemberProfileMock.mockReturnValue({ data: baseData(), isLoading: false, isError: false });
    renderRoute("/members/not-a-uuid/settlement");
    expect(screen.getByTestId("members-sentinel")).toBeInTheDocument();
    expect(useMemberProfileMock).not.toHaveBeenCalled();
  });

  it("loading state — ProfileSkeleton renders", () => {
    useMemberProfileMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderRoute(`/members/${VALID_ID}/settlement`);
    // ProfileSkeleton has aria-label set via the prop — our route passes the
    // settlement title so the SR announces something meaningful.
    expect(screen.getByLabelText(/Paiement du membre/)).toBeInTheDocument();
  });

  it("error state — ProfileError renders with back link", () => {
    useMemberProfileMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderRoute(`/members/${VALID_ID}/settlement`);
    // ProfileError exposes the back CTA via the backLabel prop — we pass
    // settlement.flow.back_label.
    expect(screen.getByRole("button", { name: /Retour au profil/ })).toBeInTheDocument();
  });

  it("Story 7.4 — clicking 'Confirmer le paiement' opens the SettlementReauthDialog", () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Confirmer le paiement/ }));
    // Dialog renders its h2 + password input.
    expect(
      screen.getByRole("heading", { level: 2, name: /Confirmation requise/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Mot de passe/)).toBeInTheDocument();
  });

  it("Story 7.4 — successful commit swaps view to EnvelopeHandoverScreen + fires toast.success", async () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    mutateAsyncMock.mockResolvedValue({
      ok: true,
      settlement_transaction_id: "33333333-3333-4333-8333-333333333333",
      settled_payout: 11_000,
      settled_at: "2026-05-14T12:34:56Z",
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Confirmer le paiement/ }));
    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "Pw-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    // EnvelopeHandoverScreen mounts — "Cycle clôturé" h2 + amount + CTA.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 2, name: /Paiement effectué/ }),
      ).toBeInTheDocument(),
    );
    // Story 12.5 \u2014 payout = contributedTotal(14 500) \u2212 daily(500) \u2212 advance(3 000) = 11 000.
    expect(screen.getByText(/11[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retour aux membres/ })).toBeInTheDocument();
    // Settlement card is gone (no more "Confirmer le paiement" button).
    expect(screen.queryByRole("button", { name: /Confirmer le paiement/ })).not.toBeInTheDocument();
    // toast.success fired with the saver's first name.
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledTimes(1));
    expect(toastSuccessMock).toHaveBeenCalledWith("Paiement effectué. SMS envoyé à Awa.");
  });

  it("Story 7.4 — payout_mismatch error → toast.error + navigates back to profile", async () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    const err = Object.assign(new Error("Payout mismatch"), {
      name: "CommitSettlementError",
      code: "payout_mismatch",
    });
    mutateAsyncMock.mockRejectedValue(err);
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Confirmer le paiement/ }));
    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "Pw-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledWith("Le montant a changé — rechargez la page.");
    // Route navigated back to profile.
    await waitFor(() => expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument());
  });

  it("Story 7.4 — cycle_not_settleable error → toast.error + back to profile", async () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    const err = Object.assign(new Error("Not settleable"), {
      name: "CommitSettlementError",
      code: "cycle_not_settleable",
    });
    mutateAsyncMock.mockRejectedValue(err);
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Confirmer le paiement/ }));
    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "Pw-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledWith("Ce cycle ne peut plus être payé.");
    await waitFor(() => expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument());
  });

  it("Story 7.4 — not_found error → toast.error + back to profile", async () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    const err = Object.assign(new Error("Not found"), {
      name: "CommitSettlementError",
      code: "not_found",
    });
    mutateAsyncMock.mockRejectedValue(err);
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Confirmer le paiement/ }));
    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "Pw-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledWith("Cycle ou membre introuvable.");
    await waitFor(() => expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument());
  });

  it("Story 7.4 — network error → toast.error + stays on settlement page", async () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    const err = Object.assign(new Error("Network down"), {
      name: "CommitSettlementError",
      code: "network",
    });
    mutateAsyncMock.mockRejectedValue(err);
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Confirmer le paiement/ }));
    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "Pw-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledWith("Pas de réseau — vérifiez votre connexion.");
    // No navigation — user stays on settlement page (network errors are retryable).
    expect(screen.queryByTestId("profile-sentinel")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: /Paiement du membre/ }),
    ).toBeInTheDocument();
  });

  it("Story 7.4 — unknown error fallback → toast.error generic + stays on page", async () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    const err = Object.assign(new Error("Unknown"), {
      name: "CommitSettlementError",
      code: "unknown",
    });
    mutateAsyncMock.mockRejectedValue(err);
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Confirmer le paiement/ }));
    fireEvent.change(screen.getByLabelText(/Mot de passe/), { target: { value: "Pw-test" } });
    fireEvent.click(screen.getByRole("button", { name: /Valider le paiement/ }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1));
    expect(toastErrorMock).toHaveBeenCalledWith("Erreur inattendue — réessayez.");
  });

  it("onVerifyTransactions — clicking 'Vérifier les transactions' navigates to the profile", () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Vérifier les transactions/ }));
    expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument();
  });

  it("advance ordering — 3 advances rendered newest-first in sub-list", () => {
    const advanceTxs = [
      makeTx("advance", 1_000, "2026-04-15T08:00:00Z"), // oldest
      makeTx("advance", 2_000, "2026-04-20T08:00:00Z"),
      makeTx("advance", 3_000, "2026-05-01T08:00:00Z"), // newest
    ];
    useMemberProfileMock.mockReturnValue({
      data: baseData({
        // Story 12.4 — route now reads allTransactions for the cycle filter.
        transactions: advanceTxs,
        allTransactions: advanceTxs,
        stats: {
          cycleDay: 30,
          cycleLength: 30,
          daysRemaining: 0,
          contributedTotal: 1_000,
          outstandingAdvances: 6_000,
          openingBalance: 0,
          // Fixture cycle is 30 days → contributionDays 29. Projected = 500 × 29 − 6 000.
          currentBalance: 500 * 29 - 6_000,
        },
      }),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    // Newest first → 3_000 first, then 2_000, then 1_000.
    expect(screen.getByText(/Avance 1 : 3[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/Avance 2 : 2[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    expect(screen.getByText(/Avance 3 : 1[\s\u00a0]000 FCFA/)).toBeInTheDocument();
    // Sum row = 6 000
    expect(screen.getByText(/− 6[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("back chevron — clicking it navigates to /members/:id", () => {
    useMemberProfileMock.mockReturnValue({
      data: baseData(),
      isLoading: false,
      isError: false,
    });
    renderRoute(`/members/${VALID_ID}/settlement`);
    fireEvent.click(screen.getByRole("button", { name: /Retour au profil/ }));
    expect(screen.getByTestId("profile-sentinel")).toBeInTheDocument();
  });
});
