// Story 4.1 — MemberActionSheet component tests.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemberActionSheet, type MemberActionSheetProps } from "./MemberActionSheet";

expect.extend(toHaveNoViolations);

// jsdom doesn't implement <dialog>'s showModal/close natively. Stub them so
// the open/close useEffect doesn't throw — matches the pattern from
// RestartCycleDialog.test.tsx (Story 2.7).
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const MEMBER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Awa Diallo",
  dailyAmount: 5000,
};

function renderSheet(overrides: Partial<MemberActionSheetProps> = {}) {
  const onOpenChange = vi.fn();
  const onViewProfile = vi.fn();
  // Build props by spreading overrides last so omitted optional handlers
  // truly stay omitted (exactOptionalPropertyTypes rejects explicit undefined).
  const props: MemberActionSheetProps = {
    open: overrides.open ?? true,
    onOpenChange,
    member: overrides.member ?? MEMBER,
    currentCycle: overrides.currentCycle ?? { status: "active" },
    onViewProfile: overrides.onViewProfile ?? onViewProfile,
    ...overrides,
  };
  const utils = render(<MemberActionSheet {...props} />);
  return { ...utils, onOpenChange, onViewProfile };
}

describe("MemberActionSheet", () => {
  it("renders the header (avatar + name) and a primary CTA with the formatted amount", () => {
    renderSheet();
    expect(screen.getByRole("heading", { level: 2, name: /awa diallo/i })).toBeInTheDocument();
    // 5000 → "5 000 FCFA" (NBSP separator from Intl.NumberFormat fr-FR).
    expect(
      screen.getByRole("button", { name: /enregistrer cotisation — 5[\s\u00a0]000 FCFA/i }),
    ).toBeInTheDocument();
  });

  it("renders the 4 secondary CTAs (Rattrapage / Prêt / Montant personnalisé / Voir profil)", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: /^rattrapage$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^prêt$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^montant personnalisé$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^voir profil$/i })).toBeInTheDocument();
  });

  it("primary CTA is disabled when onRecordContribution is omitted (Story 4.1 default)", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: /enregistrer cotisation/i })).toBeDisabled();
  });

  it("primary CTA is enabled + calls onRecordContribution + closes when handler is provided", () => {
    const onRecordContribution = vi.fn();
    const { onOpenChange } = renderSheet({ onRecordContribution });
    const cta = screen.getByRole("button", { name: /enregistrer cotisation/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(onRecordContribution).toHaveBeenCalledWith(MEMBER.id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Voir profil calls onViewProfile + closes the sheet", () => {
    const { onOpenChange, onViewProfile } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /^voir profil$/i }));
    expect(onViewProfile).toHaveBeenCalledWith(MEMBER.id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the closed-cycle banner + disables transaction CTAs (Voir profil stays enabled) when status=completed", () => {
    const onRecordContribution = vi.fn();
    renderSheet({
      currentCycle: { status: "completed" },
      onRecordContribution,
      onRattrapage: vi.fn(),
      onAdvance: vi.fn(),
      onCustomAmount: vi.fn(),
    });
    expect(screen.getByText(/le cycle est clôturé/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enregistrer cotisation/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^rattrapage$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^prêt$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^montant personnalisé$/i })).toBeDisabled();
    // Voir profil MUST stay enabled — user needs to reach the profile to restart.
    expect(screen.getByRole("button", { name: /^voir profil$/i })).toBeEnabled();
  });

  it("closed-cycle banner does NOT render when currentCycle is null", () => {
    renderSheet({ currentCycle: null });
    expect(screen.queryByText(/le cycle est clôturé/i)).not.toBeInTheDocument();
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = renderSheet({
      onRecordContribution: vi.fn(),
      onRattrapage: vi.fn(),
      onAdvance: vi.fn(),
      onCustomAmount: vi.fn(),
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // ---------------------------------------------------------------------
  // Story 4.4 — long-press + inline rattrapage grid.
  // ---------------------------------------------------------------------

  describe("Story 4.4 — rattrapage grid", () => {
    it("tap secondary 'Rattrapage' link → grid opens with 3 options", () => {
      renderSheet({ onRattrapage: vi.fn(), daysRemaining: 20 });
      // Grid not visible initially.
      expect(screen.queryByRole("group", { name: /sélectionnez le nombre de jours/i })).toBeNull();
      // Tap the link.
      fireEvent.click(screen.getByRole("button", { name: /^rattrapage$/i }));
      const grid = screen.getByRole("group", { name: /sélectionnez le nombre de jours/i });
      expect(grid).toBeInTheDocument();
      expect(grid.querySelectorAll("[data-rattrapage-option]")).toHaveLength(3);
    });

    it("grid options grey out when N > daysRemaining (e.g., daysRemaining=2 → only × 2 jours enabled)", () => {
      renderSheet({ onRattrapage: vi.fn(), daysRemaining: 2 });
      fireEvent.click(screen.getByRole("button", { name: /^rattrapage$/i }));
      expect(screen.getByRole("button", { name: /× 2 jours/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /× 3 jours/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /× 4 jours/i })).toBeDisabled();
    });

    it("tap an enabled grid option → onRattrapage called with (memberId, n) + sheet closes", () => {
      const onRattrapage = vi.fn();
      const { onOpenChange } = renderSheet({ onRattrapage, daysRemaining: 10 });
      fireEvent.click(screen.getByRole("button", { name: /^rattrapage$/i }));
      fireEvent.click(screen.getByRole("button", { name: /× 3 jours/i }));
      expect(onRattrapage).toHaveBeenCalledWith(MEMBER.id, 3);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("long-press on the primary CTA (≥ 500ms) reveals the grid AND suppresses the click commit", () => {
      vi.useFakeTimers();
      const onRecordContribution = vi.fn();
      const onRattrapage = vi.fn();
      try {
        renderSheet({ onRecordContribution, onRattrapage, daysRemaining: 10 });
        const cta = screen.getByRole("button", { name: /enregistrer cotisation/i });
        fireEvent.pointerDown(cta);
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(
          screen.getByRole("group", { name: /sélectionnez le nombre de jours/i }),
        ).toBeInTheDocument();
        fireEvent.pointerUp(cta);
        fireEvent.click(cta);
        expect(onRecordContribution).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("short press (< 500ms) commits a contribution as usual; grid stays closed", () => {
      vi.useFakeTimers();
      const onRecordContribution = vi.fn();
      const onRattrapage = vi.fn();
      try {
        renderSheet({ onRecordContribution, onRattrapage, daysRemaining: 10 });
        const cta = screen.getByRole("button", { name: /enregistrer cotisation/i });
        fireEvent.pointerDown(cta);
        act(() => {
          vi.advanceTimersByTime(200); // < 500ms
        });
        fireEvent.pointerUp(cta);
        fireEvent.click(cta);
        expect(onRecordContribution).toHaveBeenCalledWith(MEMBER.id);
        expect(
          screen.queryByRole("group", { name: /sélectionnez le nombre de jours/i }),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("closed-cycle disables long-press → grid never opens", () => {
      vi.useFakeTimers();
      const onRattrapage = vi.fn();
      try {
        renderSheet({
          currentCycle: { status: "completed" },
          onRattrapage,
          onRecordContribution: vi.fn(),
          daysRemaining: 10,
        });
        const cta = screen.getByRole("button", { name: /enregistrer cotisation/i });
        fireEvent.pointerDown(cta);
        act(() => {
          vi.advanceTimersByTime(600);
        });
        expect(
          screen.queryByRole("group", { name: /sélectionnez le nombre de jours/i }),
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
