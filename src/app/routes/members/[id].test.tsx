// Story 2.4 — /members/:id route smoke tests.
// Story 6.7 — added tap-opens-receipt-sheet regression (AC #22).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as MemberModule from "@/features/member";

const useMemberProfileMock = vi.fn();

vi.mock("@/features/member", async () => {
  const actual = await vi.importActual<typeof MemberModule>("@/features/member");
  return {
    ...actual,
    useMemberProfile: (id: string | undefined) => useMemberProfileMock(id),
  };
});

import MemberProfileRoute from "./[id]";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

const MEMBER = {
  id: VALID_ID,
  collector_id: "00000000-0000-4000-8000-000000000001",
  name: "Awa Diallo",
  phone_number: "+221777915898",
  daily_amount: 500,
  status: "active" as const,
  created_at: "2026-04-12T08:00:00Z",
  updated_at: "2026-04-12T08:00:00Z",
  // Story 6.7 — column exposed via members_decrypted.
  sms_opt_out: false,
};

function renderRoute(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/members/:id" element={<MemberProfileRoute />} />
          <Route path="/members" element={<div data-testid="members-list" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemberProfileRoute", () => {
  beforeEach(() => {
    useMemberProfileMock.mockReset();
  });

  it("renders the not-found state when the :id is not a UUID", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    });
    renderRoute("/members/not-a-uuid");
    expect(screen.getByText(/membre introuvable/i)).toBeInTheDocument();
  });

  it("renders the loading skeleton while the query is pending", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
    });
    renderRoute(`/members/${VALID_ID}`);
    expect(screen.getByLabelText(/historique du cycle/i)).toBeInTheDocument();
  });

  it("renders the error state on PostgREST failure", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
    });
    renderRoute(`/members/${VALID_ID}`);
    expect(screen.getByText(/impossible de charger le profil/i)).toBeInTheDocument();
  });

  it("renders the not-found state when data === undefined post-load", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    });
    renderRoute(`/members/${VALID_ID}`);
    expect(screen.getByText(/membre introuvable/i)).toBeInTheDocument();
  });

  it("renders the full MemberProfile on success", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        member: MEMBER,
        currentCycle: {
          id: "22222222-2222-4222-8222-222222222222",
          cycle_number: 1,
          start_date: "2026-04-12",
          end_date: "2026-05-11",
          status: "active",
        },
        previousCycles: [],
        transactions: [],
        totalTransactionsCount: 0,
        stats: {
          cycleDay: 11,
          daysRemaining: 19,
          contributedTotal: 0,
          outstandingAdvances: 0,
          projectedFinalBalance: 14500,
        },
      },
    });
    renderRoute(`/members/${VALID_ID}`);
    expect(screen.getByRole("heading", { level: 1, name: /awa diallo/i })).toBeInTheDocument();
    expect(screen.getByText(/aucune transaction enregistrée/i)).toBeInTheDocument();
  });

  it("Story 2.5 — renders the Modifier link as a real link to /members/:id/edit (not disabled)", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        member: MEMBER,
        currentCycle: {
          id: "22222222-2222-4222-8222-222222222222",
          cycle_number: 1,
          start_date: "2026-04-12",
          end_date: "2026-05-11",
          status: "active",
        },
        previousCycles: [],
        transactions: [],
        totalTransactionsCount: 0,
        stats: {
          cycleDay: 11,
          daysRemaining: 19,
          contributedTotal: 0,
          outstandingAdvances: 0,
          projectedFinalBalance: 14500,
        },
      },
    });
    renderRoute(`/members/${VALID_ID}`);
    const modifier = screen.getByRole("link", { name: /modifier/i });
    expect(modifier).toHaveAttribute("href", `/members/${VALID_ID}/edit`);
    // Story 2.7 — Restart action is hidden when current cycle is active.
    expect(screen.queryByRole("button", { name: /redémarrer/i })).not.toBeInTheDocument();
    // Story 2.6 — Supprimer is now a real destructive button (no longer disabled).
    expect(screen.getByRole("button", { name: /supprimer/i })).toBeEnabled();
  });

  it("Story 2.7 — renders the Restart button when the current cycle is completed", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        member: MEMBER,
        currentCycle: {
          id: "22222222-2222-4222-8222-222222222222",
          cycle_number: 1,
          start_date: "2026-04-12",
          end_date: "2026-05-11",
          status: "completed",
        },
        previousCycles: [],
        transactions: [],
        totalTransactionsCount: 30,
        stats: {
          cycleDay: 30,
          daysRemaining: 0,
          contributedTotal: 14500,
          outstandingAdvances: 0,
          projectedFinalBalance: 14500,
        },
      },
    });
    renderRoute(`/members/${VALID_ID}`);
    expect(screen.getByRole("button", { name: /redémarrer/i })).toBeInTheDocument();
  });

  // Story 6.7 AC #22 — tapping a transaction row opens the receipt sheet.
  it("Story 6.7 — tapping a transaction opens the receipt sheet", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        member: MEMBER,
        currentCycle: {
          id: "22222222-2222-4222-8222-222222222222",
          cycle_number: 1,
          start_date: "2026-04-12",
          end_date: "2026-05-11",
          status: "active",
        },
        previousCycles: [],
        transactions: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            member_id: VALID_ID,
            cycle_id: "22222222-2222-4222-8222-222222222222",
            kind: "contribution" as const,
            amount: 500,
            cycle_day: 1,
            created_at: "2026-04-12T09:00:00Z",
            receipt_token: "a".repeat(32),
          },
        ],
        totalTransactionsCount: 1,
        stats: {
          cycleDay: 11,
          daysRemaining: 19,
          contributedTotal: 500,
          outstandingAdvances: 0,
          projectedFinalBalance: 14500,
        },
      },
    });
    // The native <dialog> jsdom polyfill is required for the sheet to mount.
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    renderRoute(`/members/${VALID_ID}`);

    const row = screen.getByRole("button", { name: /Voir le reçu de Cotisation/i });
    fireEvent.click(row);
    expect(
      screen.getByRole("heading", { level: 2, name: /reçu de la transaction/i }),
    ).toBeInTheDocument();
  });

  it("Story 7.3 — 'Clôturer le cycle' link is present when cycle.status === 'completed'", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        member: MEMBER,
        currentCycle: {
          id: "22222222-2222-4222-8222-222222222222",
          cycle_number: 1,
          start_date: "2026-04-12",
          end_date: "2026-05-11",
          status: "completed",
        },
        previousCycles: [],
        transactions: [],
        totalTransactionsCount: 0,
        stats: {
          cycleDay: 30,
          daysRemaining: 0,
          contributedTotal: 0,
          outstandingAdvances: 0,
          projectedFinalBalance: 14500,
        },
      },
    });
    renderRoute(`/members/${VALID_ID}`);
    const link = screen.getByRole("link", { name: /Clôturer le cycle/ });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe(`/members/${VALID_ID}/settlement`);
  });

  it("Story 7.3 — 'Clôturer le cycle' link is NOT rendered when cycle.status === 'active'", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        member: MEMBER,
        currentCycle: {
          id: "22222222-2222-4222-8222-222222222222",
          cycle_number: 1,
          start_date: "2026-04-12",
          end_date: "2026-05-11",
          status: "active",
        },
        previousCycles: [],
        transactions: [],
        totalTransactionsCount: 0,
        stats: {
          cycleDay: 11,
          daysRemaining: 19,
          contributedTotal: 0,
          outstandingAdvances: 0,
          projectedFinalBalance: 14500,
        },
      },
    });
    renderRoute(`/members/${VALID_ID}`);
    expect(screen.queryByRole("link", { name: /Clôturer le cycle/ })).not.toBeInTheDocument();
  });

  it("Story 7.3 — 'Clôturer le cycle' link is NOT rendered when cycle.status === 'settled'", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        member: MEMBER,
        currentCycle: {
          id: "22222222-2222-4222-8222-222222222222",
          cycle_number: 1,
          start_date: "2026-04-12",
          end_date: "2026-05-11",
          status: "settled",
        },
        previousCycles: [],
        transactions: [],
        totalTransactionsCount: 0,
        stats: {
          cycleDay: 30,
          daysRemaining: 0,
          contributedTotal: 0,
          outstandingAdvances: 0,
          projectedFinalBalance: 14500,
        },
      },
    });
    renderRoute(`/members/${VALID_ID}`);
    expect(screen.queryByRole("link", { name: /Clôturer le cycle/ })).not.toBeInTheDocument();
  });
});
