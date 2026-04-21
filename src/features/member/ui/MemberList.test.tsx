import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberWithMeta } from "../types";

expect.extend(toHaveNoViolations);

const useMembersMock = vi.fn();

vi.mock("../api/useMembers", () => ({
  useMembers: () => useMembersMock(),
  MEMBERS_QUERY_KEY: ["members", "list"],
}));

// Import AFTER the mock so the component uses the stub.
import { MemberList } from "./MemberList";

const makeMember = (overrides: Partial<MemberWithMeta>): MemberWithMeta => ({
  id: overrides.id ?? "id",
  name: overrides.name ?? "Fatou Ndiaye",
  phoneNumber: null,
  dailyAmount: 500,
  displayStatus: overrides.displayStatus ?? "actif",
  currentCycle: { id: "c", startDate: "2026-04-11", dayNumber: 11 },
  latestInteractionAt: overrides.latestInteractionAt ?? "2026-04-20T10:00:00Z",
  ...overrides,
});

const renderWithRouter = () =>
  render(
    <MemoryRouter>
      <MemberList />
    </MemoryRouter>,
  );

describe("MemberList", () => {
  beforeEach(() => {
    useMembersMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing (null) while loading", () => {
    useMembersMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });
    const { container } = renderWithRouter();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the load-error copy on PostgREST error", () => {
    useMembersMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    });
    renderWithRouter();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/impossible de charger la liste des membres/i)).toBeInTheDocument();
  });

  it("renders the 0-member EmptyState (reuses the Story 1.5 copy keys)", () => {
    useMembersMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    expect(
      screen.getByRole("heading", { level: 1, name: /aucun membre pour l'instant/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ajouter mon premier membre/i })).toBeInTheDocument();
  });

  it("renders all members as cards when nothing is filtered", () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({ id: "1", name: "Fatou Ndiaye" }),
        makeMember({ id: "2", name: "Bah Diallo" }),
        makeMember({ id: "3", name: "Amadou Sow" }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    expect(screen.getByRole("heading", { level: 2, name: /fatou ndiaye/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /bah diallo/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /amadou sow/i })).toBeInTheDocument();
  });

  it("filters by search input (case-insensitive substring match)", () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({ id: "1", name: "Fatou Ndiaye" }),
        makeMember({ id: "2", name: "Bah Diallo" }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    fireEvent.change(screen.getByLabelText(/rechercher un membre/i), { target: { value: "fa" } });
    expect(screen.getByRole("heading", { level: 2, name: /fatou ndiaye/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 2, name: /bah diallo/i }),
    ).not.toBeInTheDocument();
  });

  it("filters are diacritic-insensitive", () => {
    useMembersMock.mockReturnValue({
      data: [makeMember({ id: "1", name: "Fâtôu Ndiaye" })],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    fireEvent.change(screen.getByLabelText(/rechercher un membre/i), {
      target: { value: "fatou" },
    });
    expect(screen.getByRole("heading", { level: 2, name: /fâtôu ndiaye/i })).toBeInTheDocument();
  });

  it("applies a single chip filter (OR semantics with no search)", () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({ id: "1", name: "A", displayStatus: "actif" }),
        makeMember({ id: "2", name: "B", displayStatus: "avance" }),
        makeMember({ id: "3", name: "C", displayStatus: "termine" }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: "Avance", pressed: false }));
    expect(screen.queryByRole("heading", { level: 2, name: "A" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "B" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "C" })).not.toBeInTheDocument();
  });

  it("applies multiple chips with OR semantics", () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({ id: "1", name: "A", displayStatus: "actif" }),
        makeMember({ id: "2", name: "B", displayStatus: "avance" }),
        makeMember({ id: "3", name: "C", displayStatus: "termine" }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: "Actif" }));
    fireEvent.click(screen.getByRole("button", { name: "Avance" }));
    expect(screen.getByRole("heading", { level: 2, name: "A" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "B" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "C" })).not.toBeInTheDocument();
  });

  it("combines chip AND search with AND semantics", () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({ id: "1", name: "Fatou", displayStatus: "avance" }),
        makeMember({ id: "2", name: "Bah", displayStatus: "avance" }),
        makeMember({ id: "3", name: "Fatim", displayStatus: "actif" }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    fireEvent.click(screen.getByRole("button", { name: "Avance" }));
    fireEvent.change(screen.getByLabelText(/rechercher un membre/i), { target: { value: "fa" } });
    expect(screen.getByRole("heading", { level: 2, name: "Fatou" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Bah" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Fatim" })).not.toBeInTheDocument();
  });

  it("shows the no-match state when search yields no results", () => {
    useMembersMock.mockReturnValue({
      data: [makeMember({ id: "1", name: "Fatou" })],
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    fireEvent.change(screen.getByLabelText(/rechercher un membre/i), { target: { value: "zzz" } });
    expect(screen.getByText(/aucun résultat/i)).toBeInTheDocument();
    expect(screen.getByText(/vérifiez l'orthographe/i)).toBeInTheDocument();
  });

  it("passes axe a11y on a populated list", async () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({ id: "1", name: "Fatou", displayStatus: "actif" }),
        makeMember({ id: "2", name: "Bah", displayStatus: "avance" }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    const { container } = renderWithRouter();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
