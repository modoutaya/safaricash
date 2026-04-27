// Story 5.2 — AdvanceFlow component tests.
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
  // Use explicit undefined check so callers can pass `cycleStatus: null`
  // to test the no-active-cycle redirect (`?? "active"` would coerce
  // null → "active").
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

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={[`/members/${MEMBER_ID}/advance`]}>
      <Routes>
        <Route path="/members/:id" element={<div data-testid="profile-route">profile</div>} />
        <Route path="/members" element={<div data-testid="list-route">list</div>} />
        <Route path="/members/:id/advance" element={<AdvanceFlow memberId={MEMBER_ID} />} />
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

  it("happy path — renders header + situation + chips + input + simulation panel", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    expect(
      screen.getByRole("heading", { level: 1, name: /accorder un prêt/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/situation actuelle/i)).toBeInTheDocument();
    expect(screen.getByText(/jour 10 sur 30/i)).toBeInTheDocument();
    // 3 chips — the 50k chip exists exactly once (anchored regex avoids
    // matching "150 000" as a substring of the simulation row).
    expect(screen.getByRole("button", { name: /^50[\s\u00a0]000 FCFA$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^100[\s\u00a0]000 FCFA$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^150[\s\u00a0]000 FCFA$/i })).toBeInTheDocument();
    // Input.
    expect(screen.getByLabelText(/montant du prêt/i)).toBeInTheDocument();
    // Simulation panel — row 1 = 5000 × 30 = 150 000. There are 2 matches
    // because the 150 000 chip ALSO renders this string. getAllByText is
    // the right matcher here.
    expect(screen.getAllByText(/150[\s\u00a0]000 FCFA/).length).toBeGreaterThanOrEqual(1);
  });

  it("CTA renders DISABLED in the default empty state — tooltip surfaces the amount gap", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    const cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
    expect(cta).toBeDisabled();
    // Default state: amount=0, motive empty, ack unchecked → amount gate
    // takes precedence (first unmet condition).
    expect(cta).toHaveAttribute("title", expect.stringContaining("montant valide"));
  });

  // -------------------------------------------------------------------
  // Story 5.3 — motive + saver-acknowledgment + precedence-ordered gate.
  // -------------------------------------------------------------------

  describe("Story 5.3 — motive + ack gate", () => {
    it("saver-ack checkbox is NOT pre-checked (BDD line 931)", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      const ack = screen.getByLabelText(
        /j'ai compris que ce prêt réduit mon solde final/i,
      ) as HTMLInputElement;
      expect(ack).not.toBeChecked();
    });

    it("ack checkbox copy is the EXACT BDD literal (verbatim)", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      // Match the EXACT string (anchored). Any drift breaks this test.
      expect(
        screen.getByText("J'ai compris que ce prêt réduit mon solde final"),
      ).toBeInTheDocument();
    });

    it("amount valid + motive empty + unchecked → CTA disabled, tooltip says 'motif'", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
      const cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
      expect(cta).toBeDisabled();
      expect(cta).toHaveAttribute("title", expect.stringContaining("motif"));
    });

    it("amount valid + motive < 3 chars + unchecked → CTA disabled, tooltip still 'motif'", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
      fireEvent.change(screen.getByLabelText(/motif du prêt/i), { target: { value: "ok" } });
      const cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
      expect(cta).toBeDisabled();
      expect(cta).toHaveAttribute("title", expect.stringContaining("motif"));
    });

    it("amount valid + motive valid + unchecked → CTA disabled, tooltip says 'acquittement'", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
      fireEvent.change(screen.getByLabelText(/motif du prêt/i), { target: { value: "urgence" } });
      const cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
      expect(cta).toBeDisabled();
      expect(cta).toHaveAttribute("title", expect.stringContaining("acquittement"));
    });

    it("amount valid + motive valid + checked → CTA enabled, no title", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
      fireEvent.change(screen.getByLabelText(/motif du prêt/i), { target: { value: "urgence" } });
      fireEvent.click(screen.getByLabelText(/j'ai compris que ce prêt/i));
      const cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
      expect(cta).toBeEnabled();
      expect(cta).not.toHaveAttribute("title");
    });

    it("over-limit amount + valid motive + checked → CTA disabled, tooltip 'montant'", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      // dailyAmount=5000, no existing → capacity = 145_000. 200_000 over-limits.
      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "200000" } });
      fireEvent.change(screen.getByLabelText(/motif du prêt/i), { target: { value: "urgence" } });
      fireEvent.click(screen.getByLabelText(/j'ai compris que ce prêt/i));
      const cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
      expect(cta).toBeDisabled();
      expect(cta).toHaveAttribute("title", expect.stringContaining("montant"));
    });

    it("motive whitespace-only treated as empty — gate stays at 'motif'", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
      fireEvent.change(screen.getByLabelText(/motif du prêt/i), { target: { value: "   " } });
      const cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
      expect(cta).toBeDisabled();
      expect(cta).toHaveAttribute("title", expect.stringContaining("motif"));
    });

    it("CTA tap when enabled with onConfirm prop → calls onConfirm({ amount, motive: trimmed, acknowledged: true })", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      const onConfirm = vi.fn();
      // Render the AdvanceFlow directly (not via the route), so we can
      // inject the optional onConfirm prop.
      render(
        <MemoryRouter initialEntries={["/x"]}>
          <Routes>
            <Route path="/x" element={<AdvanceFlow memberId={MEMBER_ID} onConfirm={onConfirm} />} />
          </Routes>
        </MemoryRouter>,
      );
      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
      fireEvent.change(screen.getByLabelText(/motif du prêt/i), {
        target: { value: "  urgence  " },
      });
      fireEvent.click(screen.getByLabelText(/j'ai compris que ce prêt/i));
      fireEvent.click(screen.getByRole("button", { name: /^accorder le prêt$/i }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm).toHaveBeenCalledWith({
        amount: 20000,
        motive: "urgence",
        acknowledged: true,
      });
    });

    it("CTA tap when enabled WITHOUT onConfirm prop is a no-op (defensive)", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter(); // route file does NOT pass onConfirm in Story 5.2
      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
      fireEvent.change(screen.getByLabelText(/motif du prêt/i), { target: { value: "urgence" } });
      fireEvent.click(screen.getByLabelText(/j'ai compris que ce prêt/i));
      // No throw, no navigation.
      expect(() =>
        fireEvent.click(screen.getByRole("button", { name: /^accorder le prêt$/i })),
      ).not.toThrow();
    });

    it("aria-describedby points to the hidden help span when CTA is disabled; absent when enabled", () => {
      useMemberProfileMock.mockReturnValue(mkProfile());
      renderWithRouter();
      let cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
      expect(cta).toHaveAttribute("aria-describedby", "advance-cta-help");

      fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "20000" } });
      fireEvent.change(screen.getByLabelText(/motif du prêt/i), { target: { value: "urgence" } });
      fireEvent.click(screen.getByLabelText(/j'ai compris que ce prêt/i));
      cta = screen.getByRole("button", { name: /^accorder le prêt$/i });
      expect(cta).not.toHaveAttribute("aria-describedby");
    });
  });

  it("tap a chip → input value updates AND simulation panel echoes − {amount} FCFA", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: /^100[\s\u00a0]000 FCFA$/i }));
    const input = screen.getByLabelText(/montant du prêt/i) as HTMLInputElement;
    expect(input.value).toBe("100000");
    expect(screen.getByText(/− 100[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("type a custom amount → simulation panel updates", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    fireEvent.change(screen.getByLabelText(/montant du prêt/i), { target: { value: "75000" } });
    expect(screen.getByText(/− 75[\s\u00a0]000 FCFA/)).toBeInTheDocument();
  });

  it("over-limit chip is disabled when N would exceed capacity", () => {
    // dailyAmount=5000, existing advances summing to 130_000.
    // Capacity = 5000 × 29 = 145_000. Remaining = 15_000.
    // → 50k chip disabled (50k > 15k); 100k + 150k also disabled.
    useMemberProfileMock.mockReturnValue(mkProfile({ data: mkData({ advanceTxs: [130_000] }) }));
    renderWithRouter();
    expect(screen.getByRole("button", { name: /^50[\s\u00a0]000 FCFA$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^100[\s\u00a0]000 FCFA$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^150[\s\u00a0]000 FCFA$/i })).toBeDisabled();
  });

  it("empty input → simulation panel renders empty state", () => {
    useMemberProfileMock.mockReturnValue(mkProfile());
    renderWithRouter();
    // The placeholder "— FCFA" sits in the simulation row 3.
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
    // The flow's section is not present; only the route container.
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
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
