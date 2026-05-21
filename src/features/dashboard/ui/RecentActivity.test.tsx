// Story 9.1 — RecentActivity tests.

import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it } from "vitest";

import type { MemberWithMeta } from "@/features/member";

import type { DashboardActivity } from "../api/deriveDashboardStats";
import { RecentActivity } from "./RecentActivity";

expect.extend(toHaveNoViolations);

const MEMBER: MemberWithMeta = {
  id: "mem-1",
  name: "Awa Diop",
  phoneNumber: "+221770000000",
  dailyAmount: 500,
  displayStatus: "actif",
  currentCycle: null,
  latestInteractionAt: "2026-05-15T00:00:00.000Z",
  cycleAdvancesTotal: 0,
  projectedBalance: null,
  awaitingSettlement: null,
};

const NOW = new Date("2026-05-15T10:00:00.000Z").getTime();

function activity(overrides: Partial<DashboardActivity> = {}): DashboardActivity {
  return {
    id: crypto.randomUUID(),
    kind: "contribution",
    memberId: "mem-1",
    amount: 500,
    createdAt: "2026-05-15T09:55:00.000000Z",
    ...overrides,
  };
}

describe("RecentActivity", () => {
  it("renders a row with the kind, member name, amount and relative time", () => {
    render(<RecentActivity activity={[activity()]} members={[MEMBER]} now={NOW} />);
    expect(screen.getByText(/Cotisation — Awa Diop/)).toBeInTheDocument();
    expect(screen.getByText(/il y a 5 min/)).toBeInTheDocument();
    expect(screen.getByText(/500/)).toBeInTheDocument();
  });

  it("falls back to a neutral label when the member is not known", () => {
    render(
      <RecentActivity
        activity={[activity({ memberId: "unknown", kind: "advance" })]}
        members={[MEMBER]}
        now={NOW}
      />,
    );
    expect(screen.getByText(/Avance — Membre/)).toBeInTheDocument();
  });

  it("renders the empty state when there is no activity", () => {
    render(<RecentActivity activity={[]} members={[MEMBER]} now={NOW} />);
    expect(screen.getByText("Aucune activité récente")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("axe-clean (populated + empty)", async () => {
    const populated = render(
      <RecentActivity activity={[activity()]} members={[MEMBER]} now={NOW} />,
    );
    expect(await axe(populated.container)).toHaveNoViolations();
    populated.unmount();
    const empty = render(<RecentActivity activity={[]} members={[MEMBER]} now={NOW} />);
    expect(await axe(empty.container)).toHaveNoViolations();
  });
});
