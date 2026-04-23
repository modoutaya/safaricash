// Story 2.5 — /members/:id/edit route smoke + impact-banner integration tests.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as MemberModule from "@/features/member";

const useMemberProfileMock = vi.fn();
const mutateAsyncMock = vi.fn();
const useUpdateMemberMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock("@/features/member", async () => {
  const actual = await vi.importActual<typeof MemberModule>("@/features/member");
  return {
    ...actual,
    useMemberProfile: (id: string | undefined) => useMemberProfileMock(id),
    useUpdateMember: () => useUpdateMemberMock(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

import MemberEditRoute from "./[id].edit";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

const MEMBER_DATA = {
  member: {
    id: VALID_ID,
    collector_id: "00000000-0000-4000-8000-000000000001",
    name: "Awa Diallo",
    phone_number: "+221777915898",
    daily_amount: 500,
    status: "active" as const,
    created_at: "2026-04-12T08:00:00Z",
    updated_at: "2026-04-12T08:00:00Z",
  },
  currentCycle: {
    id: "22222222-2222-4222-8222-222222222222",
    cycle_number: 1,
    start_date: "2026-04-12",
    end_date: "2026-05-11",
    status: "active" as const,
  },
  transactions: [],
  stats: {
    cycleDay: 11,
    daysRemaining: 19,
    contributedTotal: 0,
    outstandingAdvances: 0,
    projectedFinalBalance: 14500,
  },
};

function renderRoute(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/members/:id/edit" element={<MemberEditRoute />} />
          <Route path="/members/:id" element={<div data-testid="profile-route" />} />
          <Route path="/members" element={<div data-testid="members-list" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemberEditRoute", () => {
  beforeEach(() => {
    useMemberProfileMock.mockReset();
    mutateAsyncMock.mockReset();
    toastSuccessMock.mockReset();
    useUpdateMemberMock.mockReturnValue({
      isPending: false,
      error: null,
      mutateAsync: mutateAsyncMock,
    });
  });

  it("renders 'membre introuvable' when :id is not a UUID", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    });
    renderRoute("/members/not-a-uuid/edit");
    expect(screen.getByText(/membre introuvable/i)).toBeInTheDocument();
  });

  it("renders the loading skeleton while the query is pending", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
    });
    renderRoute(`/members/${VALID_ID}/edit`);
    expect(screen.getByLabelText(/modifier le membre/i)).toBeInTheDocument();
  });

  it("renders the error state on profile load failure", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
    });
    renderRoute(`/members/${VALID_ID}/edit`);
    expect(screen.getByText(/impossible de charger le profil/i)).toBeInTheDocument();
  });

  it("seeds the form with the member's current values on success", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: MEMBER_DATA,
    });
    renderRoute(`/members/${VALID_ID}/edit`);
    expect(screen.getByLabelText("Nom")).toHaveValue("Awa Diallo");
    expect(screen.getByLabelText("Cotisation quotidienne (FCFA)")).toHaveValue(500);
  });

  it("hides the impact alert on initial render and shows it after daily_amount changes", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: MEMBER_DATA,
    });
    renderRoute(`/members/${VALID_ID}/edit`);

    expect(
      screen.queryByText(/cette modification affectera le cycle en cours/i),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "1000" },
    });

    expect(screen.getByText(/cette modification affectera le cycle en cours/i)).toBeInTheDocument();
  });

  it("does NOT render the impact alert when only the name changes", () => {
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: MEMBER_DATA,
    });
    renderRoute(`/members/${VALID_ID}/edit`);
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Awa N." } });
    expect(
      screen.queryByText(/cette modification affectera le cycle en cours/i),
    ).not.toBeInTheDocument();
  });

  it("submits to useUpdateMember + toasts + navigates back to /members/:id", async () => {
    mutateAsyncMock.mockResolvedValue(undefined);
    useMemberProfileMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: MEMBER_DATA,
    });
    renderRoute(`/members/${VALID_ID}/edit`);

    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "1000" },
    });
    const cta = screen.getByRole("button", { name: /^enregistrer$/i });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);

    await waitFor(() =>
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        id: VALID_ID,
        values: { name: "Awa Diallo", phoneNumber: "+221777915898", dailyAmount: 1000 },
      }),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Modifications enregistrées ✓");
    expect(screen.getByTestId("profile-route")).toBeInTheDocument();
  });
});
