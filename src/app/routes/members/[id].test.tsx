// Story 2.4 — /members/:id route smoke tests.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
        transactions: [],
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
});
