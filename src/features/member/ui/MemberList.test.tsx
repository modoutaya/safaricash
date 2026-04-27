import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MemberWithMeta } from "../types";

expect.extend(toHaveNoViolations);

// Story 4.3 — MemberList now consumes useRecordContribution which needs a
// QueryClientProvider. Wrap all renders in one.
function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

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
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <MemberList />
      </MemoryRouter>
    </QueryClientProvider>,
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
    // Neither the header CTA nor the FAB should render on the empty branch —
    // the EmptyState component owns the sole CTA there.
    expect(screen.queryByRole("link", { name: /ajouter un membre/i })).not.toBeInTheDocument();
  });

  it("populated list with ≤10 members renders the HEADER 'Ajouter un membre' CTA (no FAB)", () => {
    const members = Array.from({ length: 5 }, (_, i) =>
      makeMember({ id: `m-${i}`, name: `Member ${i}` }),
    );
    useMembersMock.mockReturnValue({
      data: members,
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    const ctas = screen.getAllByRole("link", { name: /ajouter un membre/i });
    // Exactly one CTA link (header button) — no FAB.
    expect(ctas).toHaveLength(1);
    // Header CTA is text-bearing; FAB has an aria-label-only icon. If this is
    // a FAB, the rendered text would be empty. The header CTA exposes the
    // label as accessible name via textContent.
    expect(ctas[0]).toHaveTextContent(/ajouter un membre/i);
    expect(ctas[0]).toHaveAttribute("href", "/members/new");
  });

  it("populated list with >10 members renders the FAB (no header CTA)", () => {
    const members = Array.from({ length: 25 }, (_, i) =>
      makeMember({ id: `m-${i}`, name: `Member ${i}` }),
    );
    useMembersMock.mockReturnValue({
      data: members,
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithRouter();
    const ctas = screen.getAllByRole("link", { name: /ajouter un membre/i });
    // Exactly one CTA link (the FAB) — no header button.
    expect(ctas).toHaveLength(1);
    // FAB: anchor with an icon child, accessible via aria-label only (no text).
    expect(ctas[0]).toHaveTextContent("");
    expect(ctas[0]).toHaveAttribute("href", "/members/new");
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

  it("Story 5.2 — tap 'Prêt' link navigates to /members/:id/advance", () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    useMembersMock.mockReturnValue({
      data: [makeMember({ id: "11111111-1111-4111-8111-111111111111", name: "Fatou" })],
      isLoading: false,
      isError: false,
      error: null,
    });
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/members"]}>
          <Routes>
            <Route path="/members" element={<MemberList />} />
            <Route
              path="/members/:id/advance"
              element={<div data-testid="advance-route">advance</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /fatou/i }));
    fireEvent.click(screen.getByRole("button", { name: /^prêt$/i }));
    expect(screen.getByTestId("advance-route")).toBeInTheDocument();
  });

  it("Story 4.1 — card tap opens the action sheet (not direct navigate); Voir profil navigates", () => {
    // jsdom doesn't implement <dialog>'s showModal/close — same shim used
    // by RestartCycleDialog.test.tsx (Story 2.7).
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    useMembersMock.mockReturnValue({
      data: [makeMember({ id: "11111111-1111-4111-8111-111111111111", name: "Fatou" })],
      isLoading: false,
      isError: false,
      error: null,
    });
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/members"]}>
          <Routes>
            <Route path="/members" element={<MemberList />} />
            <Route path="/members/:id" element={<div data-testid="profile-route">profile</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Card tap opens the action sheet (no immediate navigate).
    fireEvent.click(screen.getByRole("button", { name: /fatou/i }));
    expect(screen.queryByTestId("profile-route")).not.toBeInTheDocument();
    // Action sheet visible — Voir profil is dialog-only and unique.
    const viewProfile = screen.getByRole("button", { name: /^voir profil$/i });
    expect(viewProfile).toBeInTheDocument();

    // Tap Voir profil → navigate to /members/:id.
    fireEvent.click(viewProfile);
    expect(screen.getByTestId("profile-route")).toBeInTheDocument();
  });

  // Story 3.5 — URL-driven cycles-ending filter.
  it("Story 3.5 — ?filter=cycles-ending shows only members in the upcoming-end window", () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({
          id: "in1",
          name: "InWindow1",
          currentCycle: { id: "c-in1", startDate: "2026-04-01", dayNumber: 25 },
        }),
        makeMember({
          id: "out1",
          name: "OutOfWindow",
          currentCycle: { id: "c-out", startDate: "2026-04-01", dayNumber: 5 },
        }),
        makeMember({
          id: "in2",
          name: "InWindow2",
          currentCycle: { id: "c-in2", startDate: "2026-04-01", dayNumber: 30 },
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/members?filter=cycles-ending"]}>
          <MemberList />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { level: 2, name: /InWindow1/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /InWindow2/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 2, name: /OutOfWindow/ }),
    ).not.toBeInTheDocument();
  });

  it("Story 3.5 — dismiss-filter chip clears the URL param and restores all members", () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({
          id: "in1",
          name: "InWindow1",
          currentCycle: { id: "c-in1", startDate: "2026-04-01", dayNumber: 25 },
        }),
        makeMember({
          id: "out1",
          name: "OutOfWindow",
          currentCycle: { id: "c-out", startDate: "2026-04-01", dayNumber: 5 },
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/members?filter=cycles-ending"]}>
          <MemberList />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("heading", { level: 2, name: /OutOfWindow/ }),
    ).not.toBeInTheDocument();

    const dismissChip = screen.getByRole("button", { name: /cycles à clôturer/i });
    fireEvent.click(dismissChip);

    expect(screen.getByRole("heading", { level: 2, name: /OutOfWindow/ })).toBeInTheDocument();
    // Chip is gone after dismissal.
    expect(screen.queryByRole("button", { name: /cycles à clôturer/i })).not.toBeInTheDocument();
  });

  it("Story 3.5 — URL filter composes with status chip via AND (avance + cycles-ending)", () => {
    useMembersMock.mockReturnValue({
      data: [
        makeMember({
          id: "actif-in",
          name: "ActifInWindow",
          displayStatus: "actif",
          currentCycle: { id: "c-a-in", startDate: "2026-04-01", dayNumber: 28 },
        }),
        makeMember({
          id: "avance-in",
          name: "AvanceInWindow",
          displayStatus: "avance",
          currentCycle: { id: "c-av-in", startDate: "2026-04-01", dayNumber: 28 },
        }),
        makeMember({
          id: "avance-out",
          name: "AvanceOutOfWindow",
          displayStatus: "avance",
          currentCycle: { id: "c-av-out", startDate: "2026-04-01", dayNumber: 5 },
        }),
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    render(
      <QueryClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={["/members?filter=cycles-ending"]}>
          <MemberList />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^avance$/i }));
    expect(screen.getByRole("heading", { level: 2, name: /AvanceInWindow/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 2, name: /ActifInWindow/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 2, name: /AvanceOutOfWindow/ }),
    ).not.toBeInTheDocument();
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
