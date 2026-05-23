import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import type { MemberWithMeta } from "../types";
import { MemberCard } from "./MemberCard";

expect.extend(toHaveNoViolations);

const makeMember = (overrides: Partial<MemberWithMeta> = {}): MemberWithMeta => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fatou Ndiaye",
  phoneNumber: "+221770000001",
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
});

describe("MemberCard", () => {
  it("renders name, initials, amount + cycle progress + status badge", () => {
    render(<MemberCard member={makeMember()} />);
    expect(screen.getByRole("heading", { level: 2, name: /fatou ndiaye/i })).toBeInTheDocument();
    expect(screen.getByText(/500\s*F CFA \/ jour/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "11");
    expect(screen.getByText("Actif")).toBeInTheDocument();
  });

  it("shows initials derived from the member name", () => {
    render(<MemberCard member={makeMember({ name: "Fatou Ndiaye" })} />);
    expect(screen.getByText("FN")).toBeInTheDocument();
  });

  it("renders the cycle day, days-remaining countdown and projected balance", () => {
    render(
      <MemberCard
        member={makeMember({
          currentCycle: {
            id: "c1",
            startDate: "2026-04-11",
            endDate: "2026-05-10",
            cycleLength: 30,
            dayNumber: 25,
            openingBalance: 0,
          },
          projectedBalance: 145000,
          awaitingSettlement: null,
          lastSettlementAt: null,
        })}
      />,
    );
    expect(screen.getByText("Jour 25 — cycle de 30 jours")).toBeInTheDocument();
    expect(screen.getByText("5 jours restants")).toBeInTheDocument();
    expect(screen.getByText(/145\s?000 F CFA/)).toBeInTheDocument();
  });

  it("renders the booked advance inline when the cycle has advances", () => {
    render(<MemberCard member={makeMember({ cycleAdvancesTotal: 50000 })} />);
    expect(screen.getByText(/Avance : 50\s?000 F CFA/)).toBeInTheDocument();
  });

  it("hides the projected balance when it is missing (null or a stale undefined)", () => {
    const { rerender } = render(<MemberCard member={makeMember({ projectedBalance: null })} />);
    expect(screen.queryByLabelText(/solde prévu/i)).not.toBeInTheDocument();
    // The rest of the cycle block still renders.
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    // A persisted cache from before the field existed surfaces `undefined`.
    rerender(
      <MemberCard
        member={{ ...makeMember(), projectedBalance: undefined as unknown as number | null }}
      />,
    );
    expect(screen.queryByLabelText(/solde prévu/i)).not.toBeInTheDocument();
  });

  it("hides the cycle block when there is no current cycle", () => {
    render(
      <MemberCard
        member={makeMember({
          currentCycle: null,
          displayStatus: "actif",
          projectedBalance: null,
          awaitingSettlement: null,
          lastSettlementAt: null,
        })}
      />,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("renders as <article> when non-interactive", () => {
    const { container } = render(<MemberCard member={makeMember()} />);
    expect(container.querySelector("article")).toBeInTheDocument();
    expect(container.querySelector("button")).not.toBeInTheDocument();
  });

  it("renders as <button> + calls onSelect(member.id) when interactive", () => {
    const onSelect = vi.fn();
    render(<MemberCard member={makeMember()} onSelect={onSelect} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("applies the min-height class for the 44px touch target (NFR-A2)", () => {
    const { container } = render(<MemberCard member={makeMember()} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/min-h-\[44px\]/);
  });

  it("formats amount with French thousand separator (non-breaking space)", () => {
    render(<MemberCard member={makeMember({ dailyAmount: 1500 })} />);
    const text = screen.getByText(/F CFA \/ jour/).textContent ?? "";
    // NBSP (U+00A0) or NARROW NBSP (U+202F) depending on Node ICU version.
    expect(text).toMatch(/1\s500/);
  });

  it("passes axe a11y checks (non-interactive)", async () => {
    const { container } = render(<MemberCard member={makeMember()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe a11y checks (interactive)", async () => {
    const { container } = render(<MemberCard member={makeMember()} onSelect={() => undefined} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
