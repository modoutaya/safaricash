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

  it("renders nothing when count is 0", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 0,
      members: dummyMembers,
      isDismissed: false,
      dismiss: vi.fn(),
      isLoading: false,
    });
    const { container } = renderWithRouter();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when dismissed", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 3,
      members: dummyMembers,
      isDismissed: true,
      dismiss: vi.fn(),
      isLoading: false,
    });
    const { container } = renderWithRouter();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while loading", () => {
    useCyclesEndingAlertMock.mockReturnValue({
      count: 0,
      members: dummyMembers,
      isDismissed: false,
      dismiss: vi.fn(),
      isLoading: true,
    });
    const { container } = renderWithRouter();
    expect(container.firstChild).toBeNull();
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
