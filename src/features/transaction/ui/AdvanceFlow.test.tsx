// Story 5.2-5.4 + Story 4.6 redesign — AdvanceFlow component tests.
//
// Mocks useMemberProfile via vi.mock so each case feeds its own data.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useMemberProfileMock = vi.fn();

vi.mock("@/features/member", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/features/member");
  return {
    ...actual,
    useMemberProfile: () => useMemberProfileMock(),
  };
});

import { AdvanceFlow } from "./AdvanceFlow";

expect.extend(toHaveNoViolations);

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID_2 = "22222222-2222-4222-8222-222222222222";

const MEMBERS = [
  { id: MEMBER_ID, name: "Awa Diallo", dailyAmount: 5000 },
  { id: MEMBER_ID_2, name: "Moussa Koné", dailyAmount: 10000 },
];

const mkProfile = (
  overrides: Partial<{
    isLoading: boolean;
    isError: boolean;
    data: ReturnType<typeof mkData> | undefined;
  }> = {},
) => ({
  isLoading: false,
  isError: false,
  data: mkData(),
  ...overrides,
});

const mkData = (
  overrides: Partial<{
    cycleStatus: "active" | "with_advance" | "completed" | "settled" | null;
    dailyAmount: number;
    cycleDay: number;
    contributedTotal: number;
    outstandingAdvances: number;
    advanceTxs: number[];
  }> = {},
) => {
  const cycleStatus = overrides.cycleStatus === undefined ? "active" : overrides.cycleStatus;
  return {
    member: {
      id: MEMBER_ID,
      collector_id: "c0",
      name: "Awa Diallo",
      phone_number: "+221770000111",
      daily_amount: overrides.dailyAmount ?? 5000,
      status: "active",
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    },
    currentCycle: cycleStatus
      ? {
          id: "cycle-1",
          cycle_number: 1,
          start_date: "2026-04-01",
          end_date: "2026-04-30",
          status: cycleStatus,
        }
      : null,
    previousCycles: [],
    transactions: (overrides.advanceTxs ?? []).map((amount, i) => ({
      id: `tx-${i}`,
      member_id: MEMBER_ID,
      cycle_id: "cycle-1",
      kind: "advance" as const,
      amount,
      cycle_day: 5,
      created_at: "2026-04-05T00:00:00Z",
    })),
    totalTransactionsCount: 0,
    stats: {
      cycleDay: overrides.cycleDay ?? 10,
      daysRemaining: 30 - (overrides.cycleDay ?? 10),
      contributedTotal: overrides.contributedTotal ?? 0,
      outstandingAdvances: overrides.outstandingAdvances ?? 0,
      projectedFinalBalance: 0,
    },
  };
};

function renderWithRouter(opts: { onConfirm?: () => void; onSelectMember?: () => void } = {}) {
  return render(
    <MemoryRouter initialEntries={[`/members/${MEMBER_ID}/advance`]}>
      <Routes>
        <Route path="/members/:id" element={<div data-testid="profile-route">profile</div>} />
        <Route path="/members" element={<div data-testid="list-route">list</div>} />
        <Route
          path="/members/:id/advance"
          element={
            <AdvanceFlow
              memberId={MEMBER_ID}
              members={MEMBERS}
              onSelectMember={opts.onSelectMember ?? vi.fn()}
              {...(opts.onConfirm ? { onConfirm: opts.onConfirm } : {})}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AdvanceFlow", () => {
  beforeEach(() => {
    useMemberProfileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — renders header + member select + situation + chips + input + simulation", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    expect(screen.getByRole("heading", { level: 1, name: /prêt express/i })).toBeInTheDocument();
    expect(screen.getByText(/sélection du membre/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/membre bénéficiaire/i)).toHaveValue(MEMBER_ID);
    expect(screen.getByText(/situation actuelle/i)).toBeInTheDocument();
    expect(screen.getByText(/^10\/30$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^50K$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^100K$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^150K$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/montant du prêt/i)).toBeInTheDocument();
    // Simulation panel — row 1 = 5000 × 30 = 150 000.
    expect(screen.getByText(/impact sur le solde final/i)).toBeInTheDocument();
    expect(screen.getByText(/150\s000 FCFA/)).toBeInTheDocument();
  });

  it("renders the amber security notice", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    expect(screen.getByText(/vérification importante/i)).toBeInTheDocument();
  });

  it("CTA renders DISABLED in the default empty state", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    const cta = screen.getByRole("button", { name: /accorder le prêt/i });
    expect(cta).toBeDisabled();
    expect(cta).toHaveAttribute("title", expect.stringContaining("montant valide"));
  });

  it("motive is optional — a valid amount alone enables the CTA", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
    const cta = screen.getByRole("button", { name: /accorder le prêt/i });
    expect(cta).toBeEnabled();
    expect(cta).not.toHaveAttribute("title");
  });

  it("over-limit amount → CTA disabled", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    // dailyAmount=5000, no existing → capacity = 145 000. 200 000 over-limits.
    fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "200000" } });
    expect(screen.getByRole("button", { name: /accorder le prêt/i })).toBeDisabled();
  });

  it("CTA tap when enabled → calls onConfirm({ amount, motive: trimmed })", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    const onConfirm = vi.fn();
    renderWithRouter({ onConfirm });
    fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
    fireEvent.change(screen.getByLabelText(/motif du prêt/i), {
      target: { value: "  urgence  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /accorder le prêt/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ amount: 20000, motive: "urgence" });
  });

  it("CTA tap with an empty motive still confirms (motive optional)", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    const onConfirm = vi.fn();
    renderWithRouter({ onConfirm });
    fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
    fireEvent.click(screen.getByRole("button", { name: /accorder le prêt/i }));
    expect(onConfirm).toHaveBeenCalledWith({ amount: 20000, motive: "" });
  });

  it("CTA tap WITHOUT onConfirm is a no-op (defensive)", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /accorder le prêt/i })),
    ).not.toThrow();
  });

  it("changing the member select calls onSelectMember", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    const onSelectMember = vi.fn();
    renderWithRouter({ onSelectMember });
    fireEvent.change(screen.getByLabelText(/membre bénéficiaire/i), {
      target: { value: MEMBER_ID_2 },
    });
    expect(onSelectMember).toHaveBeenCalledWith(MEMBER_ID_2);
  });

  it("tap a chip → input value updates AND simulation echoes the amount", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: /^100K$/i }));
    const input = screen.getByLabelText(/montant du prêt/i) as HTMLInputElement;
    expect(input.value).toBe("100000");
    expect(screen.getByText(/100\s000 FCFA/)).toBeInTheDocument();
  });

  it("type a custom amount → simulation panel updates", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "75000" } });
    expect(screen.getByText(/75\s000 FCFA/)).toBeInTheDocument();
  });

  it("over-limit chip is disabled when N would exceed capacity", () => {
    // dailyAmount=5000, existing advances summing to 130 000.
    // Capacity = 5000 × 29 = 145 000. Remaining = 15 000.
    useMemberProfileMock.mockReturnValue(mkProfile({ data: mkData({ advanceTxs: [130_000] }) }));
    renderWithRouter();
    expect(screen.getByRole("button", { name: /^50K$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^100K$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^150K$/i })).toBeDisabled();
  });

  it("empty input → simulation panel renders empty state", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    expect(screen.getByText(/— FCFA/)).toBeInTheDocument();
  });

  it("closed-cycle member → redirects to profile", () => {
    useMemberProfileMock.mockReturnValue(mkProfile({ data: mkData({ cycleStatus: "completed" }) }));
    renderWithRouter();
    expect(screen.getByTestId("profile-route")).toBeInTheDocument();
  });

  it("no active cycle → redirects to profile", () => {
    useMemberProfileMock.mockReturnValue(mkProfile({ data: mkData({ cycleStatus: null }) }));
    renderWithRouter();
    expect(screen.getByTestId("profile-route")).toBeInTheDocument();
  });

  it("loading state — renders nothing", () => {
    useMemberProfileMock.mockReturnValue(mkProfile({ isLoading: true, data: undefined }));
    const { container } = renderWithRouter();
    expect(container.querySelector("h1")).toBeNull();
  });

  it("error state — renders error fallback with retour link", () => {
    useMemberProfileMock.mockReturnValue(mkProfile({ isError: true, data: undefined }));
    renderWithRouter();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/impossible de charger ce membre/i)).toBeInTheDocument();
  });

  it("axe-clean on the happy state", async () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    const { container } = renderWithRouter();
    expect(await axe(container)).toHaveNoViolations();
  });
});
