// Story 12.1 + 12.2 — JournalMemberSection collapsed-by-default + lazy
// fetch + calendar-view rendering (missing rows + rattrapage suppression).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { JournalMember } from "../api/useJournalMembers";
import type { JournalTransaction } from "../api/useJournalTransactions";
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
    period: "cycle_previous" | "cycle_current" | "last_seven_days";
    now: Date;
  }> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Pass `now` only when defined — exactOptionalPropertyTypes rejects
  // `undefined` as a value for an optional prop.
  const sectionProps = {
    member: props.member ?? baseMember,
    period: props.period ?? ("cycle_previous" as const),
    ...(props.now ? { now: props.now } : {}),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <JournalMemberSection {...sectionProps} />
    </QueryClientProvider>,
  );
}

function makeTx(input: {
  kind: "contribution" | "rattrapage" | "advance";
  cycleId: string;
  cycleDay: number;
  daysCovered?: number;
  amount?: number;
  id?: string;
}): JournalTransaction {
  return {
    id: input.id ?? `tx-${input.cycleDay}-${input.kind}`,
    kind: input.kind,
    amount: input.amount ?? 500,
    createdAt: "2026-04-15T10:00:00Z",
    cycleDay: input.cycleDay,
    cycleId: input.cycleId,
    daysCovered: input.daysCovered ?? null,
  };
}

describe("JournalMemberSection", () => {
  it("renders collapsed by default and shows the member name in the summary", () => {
    mockUseJournalTransactions.mockReturnValue({ data: [], isLoading: false, error: null });
    renderSection();
    expect(screen.getByText("Khadim Ndiaye")).toBeInTheDocument();
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

  it("Story 12.2 — calendar fill: contributed days render as Cotisation rows, gaps render as Jour manqué", () => {
    // Previous cycle (April 1-30) with contributions on cycle_day 12, 13, 17.
    // Today set to 2026-05-01 so the full cycle's calendar is visible.
    mockUseJournalTransactions.mockReturnValue({
      data: [
        makeTx({ kind: "contribution", cycleId: "c1", cycleDay: 12 }),
        makeTx({ kind: "contribution", cycleId: "c1", cycleDay: 13 }),
        makeTx({ kind: "contribution", cycleId: "c1", cycleDay: 17 }),
      ],
      isLoading: false,
      error: null,
    });
    renderSection({ now: new Date("2026-05-01T00:00:00Z") });

    // 3 Cotisation rows + 26 missing-day rows (29 - 3 = 26).
    expect(screen.getAllByText("Cotisation")).toHaveLength(3);
    expect(screen.getAllByText("Jour manqué")).toHaveLength(26);
  });

  it("Story 12.2 — rattrapage with daysCovered=3 → single chip with '· 3 jours' suffix, no row for days 11/12", () => {
    mockUseJournalTransactions.mockReturnValue({
      data: [makeTx({ kind: "rattrapage", cycleId: "c1", cycleDay: 10, daysCovered: 3 })],
      isLoading: false,
      error: null,
    });
    renderSection({ now: new Date("2026-05-01T00:00:00Z") });

    // One Rattrapage row with the suffix.
    expect(screen.getByText(/Rattrapage\s+·\s+3 jours/)).toBeInTheDocument();
    // 26 missing rows: cycle days 1..29 minus the 3 covered (10/11/12) = 26.
    expect(screen.getAllByText("Jour manqué")).toHaveLength(26);
  });
});
