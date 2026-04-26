// Story 3.5 — CycleEndingAlert component tests.
//
// Mocks the useCyclesEndingAlert hook directly so the component test
// stays focused on rendering + interaction without seeding the real
// useMembers cache.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberWithMeta } from "@/features/member";

const useCyclesEndingAlertMock = vi.fn();

vi.mock("../api/useCyclesEndingAlert", () => ({
  useCyclesEndingAlert: () => useCyclesEndingAlertMock(),
}));

import { CycleEndingAlert } from "./CycleEndingAlert";

expect.extend(toHaveNoViolations);

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <CycleEndingAlert />
    </MemoryRouter>,
  );
}

const dummyMembers: MemberWithMeta[] = [];

describe("CycleEndingAlert", () => {
  beforeEach(() => {
    useCyclesEndingAlertMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders an empty live region (sr-only) when count is 0 — keeps the live region mounted for SR announce-on-mutation", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 0,
      members: dummyMembers,
      isDismissed: false,
      dismiss: vi.fn(),
      isLoading: false,
    });
    renderWithRouter();
    const region = screen.getByTestId("cycle-ending-alert");
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-live", "polite");
    // Empty content: no title, no link, no dismiss button.
    expect(screen.queryByText(/Cycles se terminant/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders empty live region when dismissed", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 3,
      members: dummyMembers,
      isDismissed: true,
      dismiss: vi.fn(),
      isLoading: false,
    });
    renderWithRouter();
    expect(screen.getByTestId("cycle-ending-alert")).toBeInTheDocument();
    expect(screen.queryByText(/Cycles se terminant/)).not.toBeInTheDocument();
  });

  it("renders empty live region while loading", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 0,
      members: dummyMembers,
      isDismissed: false,
      dismiss: vi.fn(),
      isLoading: true,
    });
    renderWithRouter();
    expect(screen.getByTestId("cycle-ending-alert")).toBeInTheDocument();
    expect(screen.queryByText(/Cycles se terminant/)).not.toBeInTheDocument();
  });

  it("renders title + count-aware body + Voir link + dismiss button when count > 0", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 3,
      members: dummyMembers,
      isDismissed: false,
      dismiss: vi.fn(),
      isLoading: false,
    });
    renderWithRouter();
    expect(screen.getByText(/Cycles se terminant cette semaine/)).toBeInTheDocument();
    expect(screen.getByText(/3 membres/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /voir/i });
    expect(link).toHaveAttribute("href", "/members?filter=cycles-ending");
    expect(screen.getByRole("button", { name: /masquer cette alerte/i })).toBeInTheDocument();
  });

  it("singular pluralisation when count is 1", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 1,
      members: dummyMembers,
      isDismissed: false,
      dismiss: vi.fn(),
      isLoading: false,
    });
    renderWithRouter();
    expect(screen.getByText(/1 membre — clôture imminente/)).toBeInTheDocument();
  });

  it("tap dismiss → calls hook.dismiss()", () => {
    const dismiss = vi.fn();
    useCyclesEndingAlertMock.mockReturnValue({
      count: 2,
      members: dummyMembers,
      isDismissed: false,
      dismiss,
      isLoading: false,
    });
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: /masquer/i }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("after dismiss → re-render with isDismissed=true → banner contents disappear", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 2,
      members: dummyMembers,
      isDismissed: false,
      dismiss: vi.fn(),
      isLoading: false,
    });
    const { rerender } = renderWithRouter();
    expect(screen.getByText(/Cycles se terminant cette semaine/)).toBeInTheDocument();

    // The second render simulates the post-dismiss state — the hook now
    // reports isDismissed=true; the banner contents must vanish (the live
    // region itself stays mounted by design — patch 6 in the code review).
    useCyclesEndingAlertMock.mockReturnValue({
      count: 2,
      members: dummyMembers,
      isDismissed: true,
      dismiss: vi.fn(),
      isLoading: false,
    });
    rerender(
      <MemoryRouter>
        <CycleEndingAlert />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Cycles se terminant cette semaine/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /voir/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /masquer/i })).not.toBeInTheDocument();
  });

  it("axe-clean", async () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 2,
      members: dummyMembers,
      isDismissed: false,
      dismiss: vi.fn(),
      isLoading: false,
    });
    const { container } = renderWithRouter();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
