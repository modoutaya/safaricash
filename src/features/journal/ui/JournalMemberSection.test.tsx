// Story 12.1 — JournalMemberSection collapsed-by-default + lazy fetch.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { JournalMember } from "../api/useJournalMembers";
import { JournalMemberSection } from "./JournalMemberSection";

// Mock the transactions hook to avoid hitting Supabase. The mock observes
// the `enabled` flag so the "lazy fetch on expand" assertion is meaningful.
const mockUseJournalTransactions = vi.fn();
vi.mock("../api/useJournalTransactions", () => ({
  useJournalTransactions: (
    args: Parameters<typeof mockUseJournalTransactions>[0],
  ): ReturnType<typeof mockUseJournalTransactions> => mockUseJournalTransactions(args),
}));

const baseMember: JournalMember = {
  id: "m1",
  name: "Khadim Ndiaye",
  currentCycle: {
    id: "c2",
    cycleNumber: 2,
    startDate: "2026-05-01",
    endDate: "2026-05-30",
  },
  previousCycle: {
    id: "c1",
    cycleNumber: 1,
    startDate: "2026-04-01",
    endDate: "2026-04-30",
  },
  lastActivityAt: "2026-05-20T10:00:00Z",
};

function renderSection(
  props: Partial<{
    member: JournalMember;
    period: "cycle_previous" | "cycle_current" | "last_two_days";
  }> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <JournalMemberSection
        member={props.member ?? baseMember}
        period={props.period ?? "cycle_previous"}
      />
    </QueryClientProvider>,
  );
}

describe("JournalMemberSection", () => {
  it("renders collapsed by default and shows the member name in the summary", () => {
    mockUseJournalTransactions.mockReturnValue({ data: [], isLoading: false, error: null });
    renderSection();
    expect(screen.getByText("Khadim Ndiaye")).toBeInTheDocument();
    // <details> collapsed → the transaction list (or empty state) is in the DOM
    // but the section is closed. We assert the toggle starts closed via the
    // `open` attribute of the parent <details>.
    const details = screen.getByText("Khadim Ndiaye").closest("details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
  });

  it("lazy fetch — useJournalTransactions is called with enabled=false before expansion", () => {
    mockUseJournalTransactions.mockReturnValue({ data: [], isLoading: false, error: null });
    renderSection();
    const lastCallArgs = mockUseJournalTransactions.mock.calls.at(-1)?.[0];
    expect(lastCallArgs?.enabled).toBe(false);
  });

  it("expanding the section flips enabled to true", () => {
    mockUseJournalTransactions.mockReturnValue({ data: [], isLoading: false, error: null });
    renderSection();
    const details = screen.getByText("Khadim Ndiaye").closest("details") as HTMLDetailsElement;
    // Flip the `open` property + dispatch the `toggle` event the way the
    // browser would. `fireEvent` has no shorthand for `toggle` (not a
    // standard React synthetic event) → use the underlying Event ctor.
    details.open = true;
    fireEvent(details, new Event("toggle", { bubbles: false }));
    const lastCallArgs = mockUseJournalTransactions.mock.calls.at(-1)?.[0];
    expect(lastCallArgs?.enabled).toBe(true);
  });

  it("renders the empty-state copy when bounds are null (no previous cycle)", () => {
    mockUseJournalTransactions.mockReturnValue({ data: [], isLoading: false, error: null });
    renderSection({
      member: { ...baseMember, previousCycle: null },
      period: "cycle_previous",
    });
    expect(screen.getByText("Aucun cycle précédent pour ce membre.")).toBeInTheDocument();
  });

  it("renders one row per fetched transaction (amount + kind chip)", () => {
    // Distinct amounts that don't share digit substrings — Intl's
    // non-breaking-space grouping otherwise lets "500 F CFA" match
    // inside "1 500 F CFA" and getByText fails on duplicate matches.
    mockUseJournalTransactions.mockReturnValue({
      data: [
        {
          id: "tx1",
          kind: "contribution",
          amount: 456,
          createdAt: "2026-04-20T09:14:00Z",
        },
        {
          id: "tx2",
          kind: "rattrapage",
          amount: 2310,
          createdAt: "2026-04-19T09:14:00Z",
        },
      ],
      isLoading: false,
      error: null,
    });
    renderSection();
    expect(screen.getByText("Cotisation")).toBeInTheDocument();
    expect(screen.getByText("Rattrapage")).toBeInTheDocument();
    expect(screen.getByText(/456\s*F CFA/)).toBeInTheDocument();
    expect(screen.getByText(/2\s?310\s*F CFA/)).toBeInTheDocument();
  });
});
